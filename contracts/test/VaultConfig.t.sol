// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IVaultConfig} from "../src/interfaces/IVaultConfig.sol";
import {AssetConfig} from "../src/interfaces/Types.sol";
import {ConfigHarness} from "./helpers/ConfigHarness.sol";

/// The platform settings a vault reads, and who may change them.
contract VaultConfigTest is Test {
    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");
    address internal tokenA = makeAddr("tokenA");
    address internal tokenB = makeAddr("tokenB");
    address internal router = makeAddr("router");

    ConfigHarness internal config;

    function setUp() public {
        config = new ConfigHarness(admin);
    }

    function _priced(address feed, uint8 tokenDecimals) internal pure returns (AssetConfig memory) {
        return AssetConfig({
            feed: feed,
            tokenDecimals: tokenDecimals,
            feedDecimals: 8,
            maxAge: 26 hours,
            session: 1,
            source: 1,
            maxWeightBps: 5000,
            pauseProbe: address(0xBEEF),
            pauseSelector: bytes4(keccak256("paused()")),
            scheduleSelector: bytes4(keccak256("effectiveAt()")),
            haltUntil: 0
        });
    }

    function _assertSame(AssetConfig memory a, AssetConfig memory b) internal pure {
        assertEq(keccak256(abi.encode(a)), keccak256(abi.encode(b)));
    }

    // ---- admin

    function test_init_setsTheAdmin() public view {
        assertEq(config.admin(), admin);
        assertEq(config.pendingAdmin(), address(0));
        assertEq(config.assets().length, 0);
    }

    function test_init_revertsOnZeroAdmin() public {
        vm.expectRevert(IVaultConfig.ZeroAddress.selector);
        new ConfigHarness(address(0));
    }

    function test_adminHandover_takesTwoSteps() public {
        address next = makeAddr("next-admin");

        vm.prank(admin);
        vm.expectEmit(address(config));
        emit IVaultConfig.AdminProposed(next);
        config.proposeAdmin(next);
        assertEq(config.admin(), admin, "nothing moves until the new admin accepts");
        assertEq(config.pendingAdmin(), next);

        vm.prank(next);
        vm.expectEmit(address(config));
        emit IVaultConfig.AdminChanged(admin, next);
        config.acceptAdmin();
        assertEq(config.admin(), next);
        assertEq(config.pendingAdmin(), address(0));

        // The old admin is now a stranger.
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, admin));
        config.setRouter(router, 1);
        vm.prank(next);
        config.setRouter(router, 1);
        assertEq(config.routerPull(router), 1);
    }

    function test_proposeAdmin_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, stranger));
        config.proposeAdmin(stranger);
        assertEq(config.pendingAdmin(), address(0));
    }

    function test_acceptAdmin_revertsForAnyoneButThePendingAdmin() public {
        address next = makeAddr("next-admin");
        vm.prank(admin);
        config.proposeAdmin(next);

        address[2] memory callers = [stranger, admin];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotPendingAdmin.selector, callers[i]));
            config.acceptAdmin();
        }
        assertEq(config.admin(), admin);
    }

    // ---- assets and their price feeds

    function test_setAsset_listsAndUpdates() public {
        AssetConfig memory a = _priced(makeAddr("feedA"), 18);
        vm.prank(admin);
        vm.expectEmit(address(config));
        emit IVaultConfig.AssetSet(tokenA, a);
        config.setAsset(tokenA, a);

        assertTrue(config.isAsset(tokenA));
        assertFalse(config.isAsset(tokenB));
        _assertSame(config.asset(tokenA), a);
        AssetConfig memory empty;
        _assertSame(config.asset(tokenB), empty);

        // A second asset, then a new feed for the first: the list keeps one entry each.
        AssetConfig memory b = _priced(makeAddr("feedB"), 6);
        AssetConfig memory a2 = _priced(makeAddr("feedA2"), 18);
        a2.haltUntil = 1_800_000_000;
        vm.startPrank(admin);
        config.setAsset(tokenB, b);
        config.setAsset(tokenA, a2);
        vm.stopPrank();

        address[] memory listed = config.assets();
        assertEq(listed.length, 2);
        assertEq(listed[0], tokenA);
        assertEq(listed[1], tokenB);
        _assertSame(config.asset(tokenA), a2);
        _assertSame(config.asset(tokenB), b);
    }

    function test_setAsset_listsAnAssetWithNoPriceSource() public {
        AssetConfig memory unpriced;
        unpriced.tokenDecimals = 6;
        vm.prank(admin);
        config.setAsset(tokenA, unpriced);
        assertTrue(config.isAsset(tokenA));
        assertEq(config.asset(tokenA).feed, address(0));
    }

    function test_setAsset_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, stranger));
        config.setAsset(tokenA, _priced(makeAddr("feedA"), 18));
        assertFalse(config.isAsset(tokenA));
    }

    function test_setAsset_revertsOnZeroToken() public {
        vm.prank(admin);
        vm.expectRevert(IVaultConfig.ZeroAddress.selector);
        config.setAsset(address(0), _priced(makeAddr("feedA"), 18));
    }

    function test_setAsset_revertsWhenAPricedAssetHasNoFeed() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.FeedRequired.selector, tokenA));
        config.setAsset(tokenA, _priced(address(0), 18));
        assertFalse(config.isAsset(tokenA));
    }

    // ---- routers

    function test_setRouter_allowsAndRemoves() public {
        assertEq(config.routerPull(router), 0);

        vm.startPrank(admin);
        vm.expectEmit(address(config));
        emit IVaultConfig.RouterSet(router, 2);
        config.setRouter(router, 2);
        assertEq(config.routerPull(router), 2);

        config.setRouter(router, 1);
        assertEq(config.routerPull(router), 1);

        config.setRouter(router, 0);
        assertEq(config.routerPull(router), 0);
        vm.stopPrank();
    }

    function test_setRouter_revertsForNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, stranger));
        config.setRouter(router, 1);
        assertEq(config.routerPull(router), 0);
    }

    function test_setRouter_revertsOnUnknownPull() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.InvalidPull.selector, uint8(3)));
        config.setRouter(router, 3);
    }

    function test_setRouter_revertsOnZeroRouter() public {
        vm.prank(admin);
        vm.expectRevert(IVaultConfig.ZeroAddress.selector);
        config.setRouter(address(0), 1);
    }

    // ---- storage

    /// The config keeps its state in one ERC-7201 namespace, so the factory can add its own beside it.
    function test_storage_isTheErc7201Namespace() public view {
        bytes32 slot =
            keccak256(abi.encode(uint256(keccak256("basket.storage.VaultConfig")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(address(uint160(uint256(vm.load(address(config), slot)))), admin);
        for (uint256 i; i < 8; ++i) {
            assertEq(vm.load(address(config), bytes32(i)), bytes32(0));
        }
    }
}
