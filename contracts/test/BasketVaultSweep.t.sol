// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {BasketVault} from "../src/BasketVault.sol";
import {IBasketVault} from "../src/interfaces/IBasketVault.sol";
import {VaultFixture} from "./helpers/VaultFixture.sol";
import {BombToken, GasBurnToken, MockToken, StockLikeToken} from "./mocks/Tokens.sol";

/// `withdrawAll` and gas. Two rules:
/// - A token is never skipped because the caller sent too little gas. Short of gas, the whole call fails,
///   so a gas estimate cannot land on a run that leaves a healthy token behind.
/// - A token that burns its gas costs the sweep a bounded amount, and is skipped.
///
/// The numbers the vault uses, repeated here so that changing them is a decision: each token's balance read
/// gets 100,000 gas, its transfer 300,000, and 420,000 must be left before each token.
abstract contract SweepFixture is VaultFixture {
    uint256 internal constant BALANCE_GAS = 100_000;
    uint256 internal constant TRANSFER_GAS = 300_000;
    uint256 internal constant RESERVE = 420_000;

    function _hold(MockToken token, uint256 amount) internal {
        _list(address(token), token.decimals());
        token.mint(owner, amount);
        vm.prank(owner);
        token.approve(address(vault), type(uint256).max);
        _depositAs(vault, address(token), amount);
        assertEq(token.balanceOf(address(vault)), amount);
    }

    /// Runs `withdrawAll` with `gasLimit` and puts the state back.
    function _sweepAt(uint256 gasLimit) internal returns (bool ok, uint256 skippedCount, bytes memory ret) {
        uint256 snap = vm.snapshotState();
        vm.prank(owner);
        (ok, ret) = address(vault).call{gas: gasLimit}(abi.encodeCall(BasketVault.withdrawAll, ()));
        if (ok) skippedCount = abi.decode(ret, (address[])).length;
        vm.revertToState(snap);
    }
}

/// The deposits happen in setUp, a transaction of their own, so the sweep under test starts cold as a real
/// transaction does. The owner puts their whole balance in, so the way out writes a fresh balance slot.
abstract contract SweepLeastGasTest is SweepFixture {
    address[] internal held;

    function _count() internal pure virtual returns (uint256);
    function _step() internal pure virtual returns (uint256);

    function _newToken() internal virtual returns (MockToken) {
        return new StockLikeToken(18);
    }

    function _afterDeposits() internal virtual {}

    function setUp() public {
        _deployPlatform();
        for (uint256 i; i < _count(); ++i) {
            MockToken token = _newToken();
            _hold(token, 100e18);
            held.push(address(token));
        }
        _afterDeposits();
    }

    /// Walks the gas limit up from far too little. At every limit the call either fails or withdraws
    /// everything: there is no limit at which it succeeds and leaves a healthy token behind.
    function test_withdrawAll_neverSkipsAHealthyTokenForLackOfGas() public {
        uint256 least;
        for (uint256 gasLimit = 20_000; gasLimit < 3_000_000; gasLimit += _step()) {
            (bool ok, uint256 skippedCount,) = _sweepAt(gasLimit);
            if (!ok) continue;
            assertEq(skippedCount, 0, "succeeded and skipped a healthy token");
            least = gasLimit;
            break;
        }
        assertGt(least, RESERVE, "the least gas that works leaves the reserve for the last token");

        vm.prank(owner);
        (bool done,) = address(vault).call{gas: least}(abi.encodeCall(BasketVault.withdrawAll, ()));
        assertTrue(done);
        for (uint256 i; i < held.length; ++i) {
            assertEq(MockToken(held[i]).balanceOf(address(vault)), 0);
            assertEq(MockToken(held[i]).balanceOf(owner), 100e18);
        }
    }

    function test_withdrawAll_saysSoWhenGasIsShort() public {
        (bool ok,, bytes memory ret) = _sweepAt(RESERVE - 20_000);
        assertFalse(ok);
        assertEq(bytes4(ret), IBasketVault.GasTooLow.selector);
    }
}

contract SweepLeastGas3Test is SweepLeastGasTest {
    function _count() internal pure override returns (uint256) {
        return 3;
    }

    function _step() internal pure override returns (uint256) {
        return 50;
    }
}

contract SweepLeastGas12Test is SweepLeastGasTest {
    function _count() internal pure override returns (uint256) {
        return 12;
    }

    function _step() internal pure override returns (uint256) {
        return 250;
    }
}

/// One honest token that needs almost all of both caps. The reserve is what guarantees it the full caps at
/// the least gas the call accepts: with a smaller reserve this token would be skipped just above it.
contract SweepLeastGasNearTheCapsTest is SweepLeastGasTest {
    function _count() internal pure override returns (uint256) {
        return 1;
    }

    function _step() internal pure override returns (uint256) {
        return 100;
    }

    function _newToken() internal override returns (MockToken) {
        return new GasBurnToken(18);
    }

    function _afterDeposits() internal override {
        GasBurnToken(held[0]).setBurn(BALANCE_GAS - 10_000, TRANSFER_GAS - 45_000);
    }
}

contract SweepHostileTokenTest is SweepFixture {
    MockToken[] internal healthy;

    function setUp() public {
        _deployPlatform();
    }

    function _holdHealthy(uint256 count) internal {
        for (uint256 i; i < count; ++i) {
            MockToken token = new MockToken(18);
            _hold(token, 100e18);
            healthy.push(token);
        }
    }

    function _assertHealthyLeft() internal view {
        for (uint256 i; i < healthy.length; ++i) {
            assertEq(healthy[i].balanceOf(owner), 100e18);
        }
    }

    /// Three tokens that burn every unit of gas they are given, among ten healthy ones. Each costs at most
    /// its caps, so the sweep finishes inside a small gas limit and the healthy ten leave. Without the caps
    /// one such token took 63/64 of the gas left, and two made the sweep impossible at any limit.
    function test_withdrawAll_tokensThatBurnTheirGas_costABoundedAmount() public {
        GasBurnToken onBalance = new GasBurnToken(18);
        GasBurnToken onTransfer = new GasBurnToken(18);
        GasBurnToken onBoth = new GasBurnToken(18);
        _hold(onBalance, 1e18);
        _holdHealthy(5);
        _hold(onTransfer, 1e18);
        _hold(onBoth, 1e18);
        _holdHealthy(5);
        onBalance.setBurn(type(uint256).max, 0);
        onTransfer.setBurn(0, type(uint256).max);
        onBoth.setBurn(type(uint256).max, type(uint256).max);

        // The worst the three can burn: two balance reads, and one balance read plus one transfer.
        uint256 burned = 2 * BALANCE_GAS + (BALANCE_GAS + TRANSFER_GAS);
        uint256 gasLimit = burned + 10 * 60_000 + RESERVE + 100_000;
        assertLt(gasLimit, 2_000_000);

        vm.prank(owner);
        (bool ok, bytes memory ret) = address(vault).call{gas: gasLimit}(abi.encodeCall(BasketVault.withdrawAll, ()));
        assertTrue(ok);
        address[] memory skipped = abi.decode(ret, (address[]));
        assertEq(skipped.length, 3);
        assertEq(skipped[0], address(onBalance));
        assertEq(skipped[1], address(onTransfer));
        assertEq(skipped[2], address(onBoth));
        _assertHealthyLeft();
    }

    /// A token whose transfer needs more than the sweep allows is skipped by the sweep and still leaves on
    /// its own, where `withdraw` passes on all the gas the owner sends.
    function test_withdrawAll_tokenOverTheCap_leavesThroughWithdraw() public {
        GasBurnToken heavy = new GasBurnToken(18);
        _hold(heavy, 1e18);
        _holdHealthy(2);
        heavy.setBurn(0, TRANSFER_GAS + 50_000);

        vm.startPrank(owner);
        address[] memory skipped = vault.withdrawAll();
        assertEq(skipped.length, 1);
        assertEq(skipped[0], address(heavy));
        _assertHealthyLeft();

        vault.withdraw(address(heavy), 1e18);
        vm.stopPrank();
        assertEq(heavy.balanceOf(owner), 1e18);
    }

    /// The same token just under the cap is swept like any other.
    function test_withdrawAll_tokenUnderTheCap_isSwept() public {
        GasBurnToken heavy = new GasBurnToken(18);
        _hold(heavy, 1e18);
        heavy.setBurn(BALANCE_GAS - 20_000, TRANSFER_GAS - 60_000);

        vm.prank(owner);
        address[] memory skipped = vault.withdrawAll();
        assertEq(skipped.length, 0);
        assertEq(heavy.balanceOf(owner), 1e18);
    }

    /// Return data is never copied past its first word, however long it is: a token that answers with eight
    /// kilobytes is swept like any other. One that answers with a megabyte spends more than its cap doing
    /// so, and is skipped at that bounded cost.
    function test_withdrawAll_longAnswers_areNotCopied() public {
        BombToken bomb = new BombToken(18);
        _hold(bomb, 5e18);
        _holdHealthy(1);

        bomb.setBomb(0x2000);
        vm.prank(owner);
        address[] memory skipped = vault.withdrawAll();
        assertEq(skipped.length, 0);
        bomb.setBomb(0);
        assertEq(bomb.balanceOf(owner), 5e18);
        _assertHealthyLeft();

        _depositAs(vault, address(bomb), 5e18);
        bomb.setBomb(0x100000);
        vm.startPrank(owner);
        uint256 gasBefore = gasleft();
        skipped = vault.withdrawAll();
        assertLt(gasBefore - gasleft(), BALANCE_GAS + 100_000);
        vm.stopPrank();
        assertEq(skipped.length, 1);
        assertEq(skipped[0], address(bomb));
    }
}
