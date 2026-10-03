// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {console2} from "forge-std/console2.sol";
import {BasketVault} from "../../src/BasketVault.sol";
import {IBasketVault} from "../../src/interfaces/IBasketVault.sol";
import {IPermit2} from "../../src/interfaces/IPermit2.sol";
import {IVaultConfig} from "../../src/interfaces/IVaultConfig.sol";
import {AssetConfig, Swap, Weight} from "../../src/interfaces/Types.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";
import {UniV4Calldata} from "./UniV4Calldata.sol";

interface IRealToken {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// The owner's swap against the real thing: the real dollar token into the real NVDA token on Robinhood
/// Chain, through the real Universal Router 2.1.2, the real Permit2 and a hookless Uniswap v4 pool.
///
/// Opt-in: every test here is skipped unless `RH_FORK_URL` is set, for example
///   RH_FORK_URL=https://robinhood.drpc.org pnpm test:contracts
/// It reads a fork at the block the rig pinned and sends nothing to any network.
///
/// What it settles that the mocks cannot: that the factory accepts the real router (the probe that refuses
/// tokens does not misfire on it) and the real tokens, that the vault's exact approval through Permit2 is
/// what the router needs, that the vault's own balance checks agree with a real fill, and that nothing is
/// left approved on the real token or inside the real Permit2. It prints the gas each call used.
contract RobinhoodForkSwapTest is VaultFixture {
    uint256 internal constant PINNED_BLOCK = 77_417_307;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address internal constant USDG_FEED = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;
    address internal constant UNIVERSAL_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address internal constant USDG_HOLDER = 0xfbcC34e25937282a3D0FbDE054A9A49E9968c51A;
    bytes32 internal constant PLAN_2 = keccak256("plan-2");

    bool internal forked;
    Weight[] internal none;

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

        // The platform as it would be configured on this chain: the two real tokens with their real
        // Chainlink feeds, the dollar token as cash, and the real router pulling through Permit2.
        vm.startPrank(admin);
        factory.setAsset(USDG, _real(USDG_FEED, 6, 0));
        factory.setAsset(NVDA, _real(NVDA_FEED, 18, 1));
        factory.setCashToken(USDG);
        factory.setRouter(UNIVERSAL_ROUTER, 2);
        vm.stopPrank();

        vm.prank(USDG_HOLDER);
        assertTrue(IRealToken(USDG).transfer(owner, 100e6));
        vm.startPrank(owner);
        IRealToken(USDG).approve(address(vault), 50e6);
        vault.deposit(50e6);
        vm.stopPrank();
    }

    function _real(address feed_, uint8 tokenDecimals, uint8 session) internal pure returns (AssetConfig memory) {
        return AssetConfig({
            feed: feed_,
            tokenDecimals: tokenDecimals,
            feedDecimals: 8,
            maxAge: 26 hours,
            session: session,
            source: 1,
            maxWeightBps: 5000,
            pauseProbe: address(0),
            pauseSelector: bytes4(0),
            scheduleSelector: bytes4(0),
            haltUntil: 0
        });
    }

    /// The hookless 0.01% USDG/NVDA pool the rig traded through.
    function _pool() internal pure returns (UniV4Calldata.PoolKey memory) {
        return UniV4Calldata.PoolKey(USDG, NVDA, 100, 1, address(0));
    }

    /// NVDA for `usdg`, at the feed's price less 1%: USDG has 6 decimals, NVDA 18 and the feed 8.
    function _minNvdaFor(uint256 usdg) internal view returns (uint256) {
        (, int256 price,,,) = IFeed(NVDA_FEED).latestRoundData();
        return usdg * 1e20 / uint256(price) * 99 / 100;
    }

    function _buy(uint256 usdg, address recipient) internal view returns (Swap memory) {
        uint256 minOut = _minNvdaFor(usdg);
        return Swap({
            router: UNIVERSAL_ROUTER,
            tokenIn: USDG,
            tokenOut: NVDA,
            amountIn: usdg,
            minOut: minOut,
            data: UniV4Calldata.exactInSingle(_pool(), USDG, usdg, minOut, recipient, block.timestamp + 300)
        });
    }

    /// The gas of the last call, as the transaction it was. Read by hand: the struct forge-std declares for
    /// `lastCallGas` has grown a field that older forge builds do not return, and the first two are the same.
    function _lastGas() internal view returns (uint256) {
        (bool ok, bytes memory ret) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        assertTrue(ok);
        (, uint64 used) = abi.decode(ret, (uint64, uint64));
        return used;
    }

    function _assertNothingApproved(address vault_, address token) internal view {
        assertEq(IRealToken(token).allowance(vault_, PERMIT2_ADDRESS), 0, "the token's allowance to Permit2");
        assertEq(IRealToken(token).allowance(vault_, UNIVERSAL_ROUTER), 0, "the token's allowance to the router");
        (uint160 inPermit2,,) = IPermit2(PERMIT2_ADDRESS).allowance(vault_, token, UNIVERSAL_ROUTER);
        assertEq(inPermit2, 0, "the allowance inside Permit2");
    }

    function test_fork_ownerSwap_buysRealNvdaThroughTheRealRouter() public onFork {
        Swap memory s = _buy(10e6, address(0));

        vm.prank(owner);
        uint256 gasBefore = gasleft();
        vault.ownerSwap(_swaps(s));
        uint256 gasUsed = gasBefore - gasleft();

        uint256 received = IRealToken(NVDA).balanceOf(address(vault));
        assertEq(IRealToken(USDG).balanceOf(address(vault)), 40e6, "exactly amountIn was spent");
        assertGe(received, s.minOut, "at least minOut arrived");
        assertLt(received, s.minOut * 102 / 99, "and the fill is within 2% of the feed's price");
        address[] memory tracked = vault.tokens();
        assertEq(tracked.length, 2);
        assertEq(tracked[1], NVDA);
        _assertNothingApproved(address(vault), USDG);

        console2.log("ownerSwap USDG -> NVDA, one swap through Universal Router 2.1.2 and Permit2");
        console2.log("  USDG spent (6 decimals):", uint256(10e6));
        console2.log("  NVDA received (18 decimals):", received);
        console2.log("  minOut, the feed's price less 1%:", s.minOut);
        console2.log("  gas used by the call:", gasUsed);

        // And back: the stock token as the input, 18 decimals through Permit2.
        uint256 minUsdg = 10e6 * 98 / 100 / 2;
        Swap memory back = Swap({
            router: UNIVERSAL_ROUTER,
            tokenIn: NVDA,
            tokenOut: USDG,
            amountIn: received / 2,
            minOut: minUsdg,
            data: UniV4Calldata.exactInSingle(_pool(), NVDA, received / 2, minUsdg, address(0), block.timestamp + 300)
        });
        vm.prank(owner);
        gasBefore = gasleft();
        vault.ownerSwap(_swaps(back));
        gasUsed = gasBefore - gasleft();
        assertEq(IRealToken(NVDA).balanceOf(address(vault)), received - received / 2);
        assertGe(IRealToken(USDG).balanceOf(address(vault)), 40e6 + minUsdg);
        _assertNothingApproved(address(vault), NVDA);
        console2.log("ownerSwap NVDA -> USDG, the same pool");
        console2.log("  USDG received (6 decimals):", IRealToken(USDG).balanceOf(address(vault)) - 40e6);
        console2.log("  gas used by the call:", gasUsed);

        // The way out, in kind.
        vm.prank(owner);
        assertEq(vault.withdrawAll().length, 0);
        assertEq(IRealToken(NVDA).balanceOf(owner), received - received / 2);
        assertEq(IRealToken(NVDA).balanceOf(address(vault)), 0);
        assertEq(IRealToken(USDG).balanceOf(address(vault)), 0);
    }

    /// A1 against the real router: call data that sends the output to someone else. The router does as it
    /// is told; the vault's balance did not rise, and the swap fails.
    function test_fork_A1_outputSentElsewhere_isRefused() public onFork {
        Swap memory s = _buy(10e6, stranger);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.ReceivedTooLittle.selector, NVDA, 0, s.minOut));
        vault.ownerSwap(_swaps(s));
        assertEq(IRealToken(USDG).balanceOf(address(vault)), 50e6);
        assertEq(IRealToken(NVDA).balanceOf(stranger), 0);
        _assertNothingApproved(address(vault), USDG);
    }

    /// A minimum the pool cannot meet: the real router refuses, and the vault reports the router's failure.
    function test_fork_minOutAboveThePoolsPrice_isRefused() public onFork {
        Swap memory s = _buy(10e6, address(0));
        s.minOut = s.minOut * 2;
        s.data = UniV4Calldata.exactInSingle(_pool(), USDG, 10e6, s.minOut, address(0), block.timestamp + 300);
        vm.prank(owner);
        vm.expectPartialRevert(IBasketVault.RouterFailed.selector);
        vault.ownerSwap(_swaps(s));
        assertEq(IRealToken(USDG).balanceOf(address(vault)), 50e6);
        _assertNothingApproved(address(vault), USDG);
    }

    function test_fork_createVaultAndBuy_inOneCall() public onFork {
        address predicted = factory.vaultOf(owner, PLAN_2);
        Weight[] memory targets = new Weight[](1);
        targets[0] = Weight(NVDA, 5000);
        Swap memory s = _buy(20e6, address(0));

        vm.startPrank(owner);
        IRealToken(USDG).approve(predicted, 40e6);
        uint256 gasBefore = gasleft();
        address made = factory.createVaultAndBuy(PLAN_2, targets, bytes32(0), 0, false, 40e6, _swaps(s));
        uint256 gasUsed = gasBefore - gasleft();
        vm.stopPrank();

        assertEq(made, predicted);
        assertEq(IRealToken(USDG).balanceOf(made), 20e6);
        assertGe(IRealToken(NVDA).balanceOf(made), s.minOut);
        assertEq(BasketVault(made).tokens().length, 2);
        _assertNothingApproved(made, USDG);
        console2.log("createVaultAndBuy: a new vault, 40 USDG in, 20 of it into NVDA");
        console2.log("  NVDA received (18 decimals):", IRealToken(NVDA).balanceOf(made));
        console2.log("  gas used by the call:", gasUsed);

        vm.prank(owner);
        gasBefore = gasleft();
        factory.createVault(keccak256("plan-3"), targets, bytes32(0), 0, false);
        console2.log("createVault alone, one target:", gasBefore - gasleft());
    }

    /// What each call costs as a transaction of its own, cold, with the 21,000 and the call data included.
    /// The numbers the app's gas estimates should land near.
    /// forge-config: default.isolate = true
    function test_fork_gas_eachCallAsItsOwnTransaction() public onFork {
        address predicted = factory.vaultOf(owner, PLAN_2);
        Weight[] memory targets = new Weight[](1);
        targets[0] = Weight(NVDA, 5000);
        Swap memory first = _buy(20e6, address(0));

        vm.startPrank(owner);
        IRealToken(USDG).approve(predicted, 50e6);
        factory.createVaultAndBuy(PLAN_2, targets, bytes32(0), 0, false, 40e6, _swaps(first));
        console2.log("gas, createVaultAndBuy with one swap:", _lastGas());

        BasketVault(predicted).deposit(10e6);
        console2.log("gas, deposit:", _lastGas());

        Swap memory buy = _buy(10e6, address(0));
        BasketVault(predicted).ownerSwap(_swaps(buy));
        console2.log("gas, ownerSwap USDG -> NVDA (a token already held):", _lastGas());

        uint256 held = IRealToken(NVDA).balanceOf(predicted);
        Swap memory sell = Swap({
            router: UNIVERSAL_ROUTER,
            tokenIn: NVDA,
            tokenOut: USDG,
            amountIn: held / 2,
            minOut: 1,
            data: UniV4Calldata.exactInSingle(_pool(), NVDA, held / 2, 1, address(0), block.timestamp + 300)
        });
        BasketVault(predicted).ownerSwap(_swaps(sell));
        console2.log("gas, ownerSwap NVDA -> USDG:", _lastGas());

        BasketVault(predicted).setTargets(targets);
        console2.log("gas, setTargets with one target:", _lastGas());

        BasketVault(predicted).withdrawAll();
        console2.log("gas, withdrawAll of two tokens:", _lastGas());

        factory.createVault(keccak256("plan-3"), targets, bytes32(0), 0, false);
        console2.log("gas, createVault with one target and no deposit:", _lastGas());
        vm.stopPrank();

        // The first buy into a token the vault does not hold yet: a fresh balance slot and a new entry in
        // `tokens`. The shared fixture's vault holds only USDG.
        vm.prank(owner);
        vault.ownerSwap(_swaps(buy));
        console2.log("gas, ownerSwap USDG -> NVDA (the first of that token):", _lastGas());
        _assertNothingApproved(address(vault), USDG);
        _assertNothingApproved(predicted, NVDA);
    }

    /// The real tokens answer `allowance` as tokens do, so neither can be made a router; the real router
    /// and the real Permit2 do not, and Permit2 is refused by name.
    function test_fork_theRouterListRefusesTheRealTokensAndPermit2() public onFork {
        vm.startPrank(admin);
        factory.removeAsset(NVDA);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.RouterIsAsset.selector, NVDA));
        factory.setRouter(NVDA, 1);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.RouterIsAsset.selector, USDG));
        factory.setRouter(USDG, 1);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.RouterReserved.selector, PERMIT2_ADDRESS));
        factory.setRouter(PERMIT2_ADDRESS, 2);
        vm.stopPrank();
        assertEq(factory.routerPull(UNIVERSAL_ROUTER), 2);
    }

    /// A stock token that was never listed is still seen as a token by the probe alone.
    function test_fork_anUnlistedRealToken_isRefusedAsARouter() public onFork {
        vm.startPrank(admin);
        VaultFixtureProbe probe = new VaultFixtureProbe();
        vm.stopPrank();
        assertTrue(probe.answersAllowance(NVDA));
        assertTrue(probe.answersAllowance(USDG));
        assertFalse(probe.answersAllowance(UNIVERSAL_ROUTER));
        assertFalse(probe.answersAllowance(PERMIT2_ADDRESS));
    }
}

/// The same question the config asks of a router: does this address answer `allowance(address,address)` with
/// a full word.
contract VaultFixtureProbe {
    function answersAllowance(address target) external view returns (bool) {
        (bool ok, bytes memory ret) =
            target.staticcall{gas: 100_000}(abi.encodeWithSignature("allowance(address,address)", target, target));
        return ok && ret.length >= 32;
    }
}
