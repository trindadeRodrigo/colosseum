// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {console2} from "forge-std/console2.sol";
import {BasketVault} from "../../src/BasketVault.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";

interface IToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// The vault's way out against the real stock token and the real dollar token of Robinhood Chain.
///
/// Opt-in: every test here is skipped unless `RH_FORK_URL` is set, for example
///   RH_FORK_URL=https://robinhood.drpc.org pnpm test:contracts
/// It reads a fork at the block the rig pinned and sends nothing to any network.
///
/// What it settles: the gas the vault's sweep gives one token (`SWEEP_BALANCE_GAS`, `SWEEP_TRANSFER_GAS`)
/// against what the real tokens use, and that no gas limit makes `withdrawAll` succeed while leaving one of
/// them behind. Before the fix there was such a window, 8,000 to 16,000 gas wide, with these two tokens.
abstract contract RobinhoodForkTest is VaultFixture {
    uint256 internal constant PINNED_BLOCK = 77_417_307;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant NVDA_HOLDER = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3;
    address internal constant USDG_HOLDER = 0xfbcC34e25937282a3D0FbDE054A9A49E9968c51A;

    // The vault's numbers, repeated so that changing them is a decision.
    uint256 internal constant BALANCE_GAS = 100_000;
    uint256 internal constant TRANSFER_GAS = 300_000;
    uint256 internal constant RESERVE = 420_000;

    bool internal forked;
    address[] internal held;

    /// The order the two tokens enter the vault's list: the last one is the one a short sweep used to skip.
    function _order() internal pure virtual returns (address first, address second);

    modifier onFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function setUp() public {
        string memory url = vm.envOr("RH_FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        forked = true;
        vm.createSelectFork(url, PINNED_BLOCK);
        _deployPlatform();

        vm.prank(NVDA_HOLDER);
        assertTrue(IToken(NVDA).transfer(owner, 0.05e18));
        vm.prank(USDG_HOLDER);
        assertTrue(IToken(USDG).transfer(owner, 100e6));

        (address first, address second) = _order();
        held.push(first);
        held.push(second);
        for (uint256 i; i < held.length; ++i) {
            _list(held[i], held[i] == NVDA ? 18 : 6);
            // The owner puts the whole balance in, so the way out writes a fresh balance slot for the owner.
            uint256 all = IToken(held[i]).balanceOf(owner);
            vm.prank(owner);
            IToken(held[i]).approve(address(vault), all);
            _depositAs(vault, held[i], all);
            assertEq(IToken(held[i]).balanceOf(owner), 0);
        }
    }

    function _name(address token) internal pure returns (string memory) {
        return token == NVDA ? "NVDA" : "USDG";
    }

    function _sweepAt(uint256 gasLimit) internal returns (bool ok, uint256 skippedCount) {
        uint256 snap = vm.snapshotState();
        vm.prank(owner);
        bytes memory ret;
        (ok, ret) = address(vault).call{gas: gasLimit}(abi.encodeCall(BasketVault.withdrawAll, ()));
        if (ok) skippedCount = abi.decode(ret, (address[])).length;
        vm.revertToState(snap);
    }

    /// What the real tokens use, cold, against what the sweep gives them. Each cap is at least four times
    /// the measured cost.
    function test_fork_realTokens_fitTheSweepsGasCaps() public onFork {
        for (uint256 i; i < held.length; ++i) {
            IToken token = IToken(held[i]);
            uint256 gasBefore = gasleft();
            uint256 balance = token.balanceOf(address(vault));
            uint256 readGas = gasBefore - gasleft();

            vm.prank(address(vault));
            gasBefore = gasleft();
            bool sent = token.transfer(owner, balance);
            uint256 transferGas = gasBefore - gasleft();
            assertTrue(sent);

            console2.log(_name(held[i]), "balanceOf gas, cold:", readGas);
            console2.log(_name(held[i]), "transfer gas, to a fresh balance:", transferGas);
            assertLt(readGas * 4, BALANCE_GAS);
            assertLt(transferGas * 4, TRANSFER_GAS);
        }
    }

    /// Walks the gas limit up in steps of 25. At every limit the sweep either fails or withdraws both
    /// tokens: the width of the window in which it succeeds and leaves one behind is zero.
    function test_fork_withdrawAll_neverSkipsARealTokenForLackOfGas() public onFork {
        address last = held[held.length - 1];
        uint256 least;
        uint256 fails;
        for (uint256 gasLimit = 20_000; gasLimit < 3_000_000; gasLimit += 25) {
            (bool ok, uint256 skippedCount) = _sweepAt(gasLimit);
            if (!ok) {
                ++fails;
                continue;
            }
            assertEq(skippedCount, 0, "succeeded and left a healthy token behind");
            least = gasLimit;
            break;
        }
        assertGt(least, RESERVE);
        console2.log("last token in the list:", _name(last));
        console2.log("  gas limits tried that failed as a whole:", fails);
        console2.log("  least gas at which withdrawAll() succeeds:", least);
        console2.log("  tokens skipped at that gas:", uint256(0));

        vm.prank(owner);
        uint256 gasBefore = gasleft();
        (bool done,) = address(vault).call{gas: least}(abi.encodeCall(BasketVault.withdrawAll, ()));
        console2.log("  gas the sweep used at that limit:", gasBefore - gasleft());
        assertTrue(done);
        assertEq(IToken(NVDA).balanceOf(address(vault)), 0);
        assertEq(IToken(USDG).balanceOf(address(vault)), 0);
        assertEq(IToken(NVDA).balanceOf(owner), 0.05e18);
        assertEq(IToken(USDG).balanceOf(owner), 100e6);
    }
}

contract RobinhoodForkNvdaLastTest is RobinhoodForkTest {
    function _order() internal pure override returns (address, address) {
        return (USDG, NVDA);
    }
}

contract RobinhoodForkUsdgLastTest is RobinhoodForkTest {
    function _order() internal pure override returns (address, address) {
        return (NVDA, USDG);
    }
}
