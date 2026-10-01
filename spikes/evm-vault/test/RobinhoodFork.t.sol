// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2, Vm} from "forge-std/Test.sol";
import {BasketVault, IERC20} from "../src/BasketVault.sol";
import {UniV4Calldata} from "../src/UniV4Calldata.sol";

/// Run against the local anvil fork of Robinhood Chain (see README):
///   forge test --match-contract RobinhoodFork --fork-url http://127.0.0.1:8546 -vv
contract RobinhoodForkTest is Test {
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address constant USDG_FEED = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;
    address constant UR = 0x204FAca1764B154221e35c0d20aBb3c525710498; // Universal Router 2.1.2
    address constant UR_OLD = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // holders found from Transfer logs at the pinned block
    address constant NVDA_HOLDER = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3; // a contract
    address constant USDG_HOLDER = 0xfbcC34e25937282a3D0FbDE054A9A49E9968c51A; // an EOA

    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");
    BasketVault vault;

    function setUp() public {
        require(block.chainid == 4663, "run with --fork-url of the RH anvil fork");
        address[] memory tokens = new address[](2);
        tokens[0] = USDG;
        tokens[1] = NVDA;
        address[] memory feeds = new address[](2);
        feeds[0] = USDG_FEED;
        feeds[1] = NVDA_FEED;
        address[] memory routers = new address[](2);
        routers[0] = UR;
        routers[1] = UR_OLD;
        BasketVault.Pull[] memory pulls = new BasketVault.Pull[](2);
        pulls[0] = BasketVault.Pull.Permit2;
        pulls[1] = BasketVault.Pull.Permit2;
        vault = new BasketVault(owner, keeper, tokens, feeds, routers, pulls, 125, 26 hours);

        vm.prank(USDG_HOLDER);
        IERC20(USDG).transfer(owner, 100e6);
        vm.startPrank(owner);
        IERC20(USDG).approve(address(vault), type(uint256).max);
        vault.deposit(USDG, 100e6);
        vm.stopPrank();
    }

    function pool(uint24 fee, int24 spacing) internal pure returns (UniV4Calldata.PoolKey memory) {
        return UniV4Calldata.PoolKey(USDG, NVDA, fee, spacing, address(0));
    }

    // 1. receive, hold, send: is there a transfer-time gate on a contract holder?
    function test_receive_hold_send() public {
        uint256 amt = 0.05e18;
        vm.recordLogs();
        vm.prank(NVDA_HOLDER);
        IERC20(NVDA).transfer(address(vault), amt);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        console2.log("logs emitted by one NVDA transfer:", logs.length);
        assertEq(IERC20(NVDA).balanceOf(address(vault)), amt, "vault received");

        vm.warp(block.timestamp + 1 hours);
        assertEq(IERC20(NVDA).balanceOf(address(vault)), amt, "held, non-rebasing");

        address fresh = makeAddr("fresh-eoa");
        vm.prank(owner);
        vault.withdraw(NVDA, amt / 2, fresh);
        assertEq(IERC20(NVDA).balanceOf(fresh), amt / 2, "vault sent to a fresh EOA");
        vm.prank(owner);
        vault.withdrawAll(owner);
        assertEq(IERC20(NVDA).balanceOf(address(vault)), 0);
        assertEq(IERC20(NVDA).balanceOf(owner), amt / 2);
        assertEq(IERC20(USDG).balanceOf(owner), 100e6);
    }

    function _swap(address router, uint24 fee, int24 spacing, bool legacy, uint256 amountIn) internal returns (uint256 gasUsed) {
        uint256 px = uint256(_answer(NVDA_FEED));
        // min out at 1% under the feed price: USDG 6dp -> NVDA 18dp, feed 8dp
        uint256 minOut = amountIn * 1e20 / px * 99 / 100;
        bytes memory data = UniV4Calldata.exactInSingle(pool(fee, spacing), USDG, amountIn, minOut, legacy, address(0), block.timestamp + 300);
        uint256 v0 = vault.valueUsd8();
        vm.prank(keeper);
        uint256 g = gasleft();
        (uint256 spent, uint256 received) = vault.keeperSwap(router, USDG, NVDA, amountIn, minOut, data);
        gasUsed = g - gasleft();
        uint256 v1 = vault.valueUsd8();
        console2.log("spent USDG (6dp):", spent);
        console2.log("received NVDA (18dp):", received);
        console2.log("feed px (8dp):", px);
        console2.log("exec px (8dp):", spent * 1e20 / received);
        console2.log("value before/after (8dp):", v0, v1);
        console2.log("keeperSwap gas (call only):", gasUsed);
        assertEq(IERC20(USDG).allowance(address(vault), PERMIT2), 0, "erc20 allowance zeroed");
    }

    function _answer(address feed) internal view returns (int256 a) {
        (, a,,,) = IAggregatorV3Like(feed).latestRoundData();
    }

    // 2. keeper swap USDG -> NVDA through Universal Router 2.1.2, 0.01% hookless v4 pool
    function test_keeperSwap_ur212_pool100() public {
        _swap(UR, 100, 1, false, 10e6);
    }

    function test_keeperSwap_ur212_pool3000() public {
        _swap(UR, 3000, 60, false, 10e6);
    }

    // the older router address takes the same (new) params struct
    function test_keeperSwap_urOld() public {
        _swap(UR_OLD, 100, 1, false, 10e6);
    }

    // the pre-2.1 params struct (no minHopPriceX36) is rejected by both routers
    function test_revert_legacyStruct() public {
        bytes memory data = UniV4Calldata.exactInSingle(pool(100, 1), USDG, 10e6, 0, true, address(0), block.timestamp + 300);
        vm.startPrank(keeper);
        vm.expectPartialRevert(BasketVault.RouterCallFailed.selector);
        vault.keeperSwap(UR, USDG, NVDA, 10e6, 0, data);
        vm.expectPartialRevert(BasketVault.RouterCallFailed.selector);
        vault.keeperSwap(UR_OLD, USDG, NVDA, 10e6, 0, data);
        vm.stopPrank();
    }

    // a larger leg, to see price impact on the 0.01% pool
    function test_keeperSwap_1000usd() public {
        vm.prank(USDG_HOLDER);
        IERC20(USDG).transfer(address(vault), 1000e6);
        _swap(UR, 100, 1, false, 1000e6);
    }

    // 3. keeper tries to send the output to itself: vault's own balance delta catches it
    function test_revert_outputToKeeper() public {
        bytes memory data = UniV4Calldata.exactInSingle(pool(100, 1), USDG, 10e6, 0, false, keeper, block.timestamp + 300);
        vm.prank(keeper);
        vm.expectRevert();
        vault.keeperSwap(UR, USDG, NVDA, 10e6, 1, data);
    }

    // 3b. same, with minOut = 0: the value invariant catches it
    function test_revert_outputToKeeper_valueInvariant() public {
        bytes memory data = UniV4Calldata.exactInSingle(pool(100, 1), USDG, 10e6, 0, false, keeper, block.timestamp + 300);
        vm.prank(keeper);
        vm.expectPartialRevert(BasketVault.ValueFell.selector);
        vault.keeperSwap(UR, USDG, NVDA, 10e6, 0, data);
    }

    // 4. keeper routes through a 90%-fee pool with minOut = 0: value invariant catches it
    function test_revert_badPool() public {
        bytes memory data = UniV4Calldata.exactInSingle(pool(900000, 18000), USDG, 10e6, 0, false, address(0), block.timestamp + 300);
        vm.prank(keeper);
        vm.expectPartialRevert(BasketVault.ValueFell.selector);
        vault.keeperSwap(UR, USDG, NVDA, 10e6, 0, data);
    }

    function test_revert_notKeeper_notOwner() public {
        vm.expectRevert(BasketVault.NotKeeper.selector);
        vault.keeperSwap(UR, USDG, NVDA, 1, 0, "");
        vm.prank(keeper);
        vm.expectRevert(BasketVault.NotOwner.selector);
        vault.withdraw(USDG, 1, keeper);
        vm.prank(keeper);
        vm.expectPartialRevert(BasketVault.RouterNotAllowed.selector);
        vault.keeperSwap(address(0xdead), USDG, NVDA, 1, 0, "");
    }
}

interface IAggregatorV3Like {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}
