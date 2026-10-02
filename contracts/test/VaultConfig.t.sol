// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IVaultConfig} from "../src/interfaces/IVaultConfig.sol";
import {AssetConfig} from "../src/interfaces/Types.sol";
import {ConfigHarness} from "./helpers/ConfigHarness.sol";
import {MockToken} from "./mocks/Tokens.sol";

/// Any contract will do as a router here: the config only checks that there is code at the address.
contract RouterStub {}

/// The platform settings a vault reads, and who may change them.
contract VaultConfigTest is Test {
    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");
    address internal tokenA;
    address internal tokenB;
    address internal router;

    ConfigHarness internal config;

    function setUp() public {
        config = new ConfigHarness(admin);
        tokenA = address(new MockToken(18));
        tokenB = address(new MockToken(6));
        router = address(new RouterStub());
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

    function _good() internal returns (AssetConfig memory) {
        return _priced(makeAddr("feedA"), 18);
    }

    function _assertSame(AssetConfig memory a, AssetConfig memory b) internal pure {
        assertEq(keccak256(abi.encode(a)), keccak256(abi.encode(b)));
    }

    function _expectOutOfBounds(bytes32 param, uint256 value, AssetConfig memory cfg) internal {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.ParamOutOfBounds.selector, param, value));
        config.setAsset(tokenA, cfg);
        assertFalse(config.isAsset(tokenA));
    }

    // ---- admin

    function test_init_setsTheAdmin() public view {
        assertEq(config.admin(), admin);
        assertEq(config.pendingAdmin(), address(0));
        assertEq(config.assets().length, 0);
        assertEq(config.cashToken(), address(0));
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

    /// Proposing the zero address takes a proposal back: the one who was proposed can no longer accept.
    function test_proposeAdmin_zeroCancelsAProposal() public {
        address next = makeAddr("next-admin");
        vm.startPrank(admin);
        config.proposeAdmin(next);
        config.proposeAdmin(address(0));
        vm.stopPrank();
        assertEq(config.pendingAdmin(), address(0));

        vm.prank(next);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotPendingAdmin.selector, next));
        config.acceptAdmin();
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
        a2.maxAge = 1 hours;
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

    /// A halt belongs to the guardian (EVM-3). A feed update by the admin must not lift it, and a listing
    /// cannot start one: `setAsset` keeps whatever halt is stored and ignores the one it is given.
    function test_setAsset_keepsTheStoredHalt() public {
        AssetConfig memory a = _good();
        a.haltUntil = 1_900_000_000;
        vm.prank(admin);
        config.setAsset(tokenA, a);
        assertEq(config.asset(tokenA).haltUntil, 0, "a listing cannot start a halt");

        config.haltForTest(tokenA, 1_800_000_000);
        AssetConfig memory a2 = _priced(makeAddr("feedA2"), 18);
        AssetConfig memory stored = _priced(makeAddr("feedA2"), 18);
        stored.haltUntil = 1_800_000_000;
        vm.prank(admin);
        vm.expectEmit(address(config));
        emit IVaultConfig.AssetSet(tokenA, stored);
        config.setAsset(tokenA, a2);

        assertEq(config.asset(tokenA).haltUntil, 1_800_000_000, "the halt outlives a feed update");
        assertEq(config.asset(tokenA).feed, a2.feed);
    }

    function test_setAsset_revertsForNonAdmin() public {
        AssetConfig memory a = _good();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, stranger));
        config.setAsset(tokenA, a);
        assertFalse(config.isAsset(tokenA));
    }

    function test_setAsset_revertsOnZeroToken() public {
        AssetConfig memory a = _good();
        vm.prank(admin);
        vm.expectRevert(IVaultConfig.ZeroAddress.selector);
        config.setAsset(address(0), a);
    }

    function test_setAsset_revertsOnAnAddressWithNoCode() public {
        address empty = makeAddr("no-code");
        AssetConfig memory a = _good();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NoCode.selector, empty));
        config.setAsset(empty, a);
        assertFalse(config.isAsset(empty));
    }

    /// A token must never also be a router: a swap whose "router" is a token could carry an `approve`.
    function test_setAsset_revertsOnAnAllowedRouter() public {
        AssetConfig memory a = _good();
        vm.startPrank(admin);
        config.setRouter(router, 1);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.AssetIsRouter.selector, router));
        config.setAsset(router, a);
        vm.stopPrank();
        assertFalse(config.isAsset(router));
    }

    function test_setAsset_revertsWhenAPricedAssetHasNoFeed() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.FeedRequired.selector, tokenA));
        config.setAsset(tokenA, _priced(address(0), 18));
        assertFalse(config.isAsset(tokenA));
    }

    function test_setAsset_revertsOnUnknownSource() public {
        AssetConfig memory a = _good();
        a.source = 2;
        _expectOutOfBounds("source", 2, a);
    }

    function test_setAsset_revertsOnUnknownSession() public {
        AssetConfig memory a = _good();
        a.session = 2;
        _expectOutOfBounds("session", 2, a);
    }

    function test_setAsset_revertsOnTokenDecimalsAbove18() public {
        AssetConfig memory a = _good();
        a.tokenDecimals = 19;
        _expectOutOfBounds("tokenDecimals", 19, a);
    }

    function test_setAsset_revertsOnFeedDecimalsAbove18() public {
        AssetConfig memory a = _good();
        a.feedDecimals = 19;
        _expectOutOfBounds("feedDecimals", 19, a);
    }

    function test_setAsset_revertsOnWeightAboveHalf() public {
        AssetConfig memory a = _good();
        a.maxWeightBps = 5001;
        _expectOutOfBounds("maxWeightBps", 5001, a);
    }

    function test_setAsset_revertsOnPriceAgeTooShort() public {
        AssetConfig memory a = _good();
        a.maxAge = 59;
        _expectOutOfBounds("maxAge", 59, a);
    }

    function test_setAsset_revertsOnPriceAgeTooLong() public {
        AssetConfig memory a = _good();
        a.maxAge = 48 hours + 1;
        _expectOutOfBounds("maxAge", 48 hours + 1, a);
    }

    function test_setAsset_acceptsTheBoundsThemselves() public {
        AssetConfig memory a = _good();
        a.tokenDecimals = 18;
        a.feedDecimals = 18;
        a.maxWeightBps = 5000;
        a.maxAge = 60;
        vm.startPrank(admin);
        config.setAsset(tokenA, a);
        a.maxAge = 48 hours;
        config.setAsset(tokenA, a);
        vm.stopPrank();
        assertEq(config.asset(tokenA).maxAge, 48 hours);
    }

    // ---- the cash token

    function test_setCashToken_setsAListedAsset() public {
        AssetConfig memory a = _good();
        vm.startPrank(admin);
        config.setAsset(tokenA, a);
        vm.expectEmit(address(config));
        emit IVaultConfig.CashTokenSet(tokenA);
        config.setCashToken(tokenA);
        vm.stopPrank();
        assertEq(config.cashToken(), tokenA);
    }

    function test_setCashToken_revertsForNonAdmin() public {
        AssetConfig memory a = _good();
        vm.prank(admin);
        config.setAsset(tokenA, a);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, stranger));
        config.setCashToken(tokenA);
        assertEq(config.cashToken(), address(0));
    }

    /// Cash must be on the list, which also rules out the zero address, an address with no code and a router.
    function test_setCashToken_revertsOnAnythingNotListed() public {
        address[2] memory notListed = [tokenB, address(0)];
        vm.startPrank(admin);
        for (uint256 i; i < notListed.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.AssetNotListed.selector, notListed[i]));
            config.setCashToken(notListed[i]);
        }
        vm.stopPrank();
        assertEq(config.cashToken(), address(0));
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

    /// Taking a router off the list must always work, even after its code is gone or it was listed as an
    /// asset by an earlier version of the rules.
    function test_setRouter_removesARouterWhoseCodeIsGone() public {
        vm.prank(admin);
        config.setRouter(router, 1);
        vm.etch(router, hex"");
        vm.prank(admin);
        config.setRouter(router, 0);
        assertEq(config.routerPull(router), 0);
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

    function test_setRouter_revertsOnAnAddressWithNoCode() public {
        address empty = makeAddr("no-code");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NoCode.selector, empty));
        config.setRouter(empty, 2);
        assertEq(config.routerPull(empty), 0);
    }

    /// A listed asset, the cash token included, must never be a router: with a token as the "router", swap
    /// data could be `approve(attacker, max)`, which moves no balance and so passes every balance check.
    function test_setRouter_revertsOnAListedAsset() public {
        AssetConfig memory a = _good();
        vm.startPrank(admin);
        config.setAsset(tokenA, a);
        config.setAsset(tokenB, _priced(makeAddr("feedB"), 6));
        config.setCashToken(tokenB);
        address[2] memory listed = [tokenA, tokenB];
        for (uint256 i; i < listed.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.RouterIsAsset.selector, listed[i]));
            config.setRouter(listed[i], 1);
        }
        vm.stopPrank();
        assertEq(config.routerPull(tokenA), 0);
        assertEq(config.routerPull(tokenB), 0);
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
