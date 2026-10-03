// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IVaultConfig, PERMIT2} from "../src/interfaces/IVaultConfig.sol";
import {AssetConfig, Params} from "../src/interfaces/Types.sol";
import {ConfigHarness} from "./helpers/ConfigHarness.sol";
import {MockPermit2} from "./mocks/Routers.sol";
import {MockToken, NoReturnToken} from "./mocks/Tokens.sol";

/// Any contract will do as a router here: the config only checks that there is code at the address.
contract RouterStub {}

/// The platform settings a vault reads, and who may change them.
contract VaultConfigTest is Test {
    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal tokenA;
    address internal tokenB;
    address internal router;

    ConfigHarness internal config;

    function setUp() public {
        config = new ConfigHarness(admin, _params());
        tokenA = address(new MockToken(18));
        tokenB = address(new MockToken(6));
        router = address(new RouterStub());
        vm.startPrank(admin);
        config.setGuardian(guardian);
        config.setKeeper(keeper);
        vm.stopPrank();
    }

    function _listBoth() internal {
        vm.startPrank(admin);
        config.setAsset(tokenA, _priced(makeAddr("feedA"), 18));
        config.setAsset(tokenB, _priced(makeAddr("feedB"), 6));
        config.setCashToken(tokenB);
        vm.stopPrank();
    }

    function _params() internal pure returns (Params memory) {
        return Params({
            toleranceBps: 125,
            lossCapBps: 200,
            bandBps: 50,
            assetCooldown: 3600,
            sessionOpen: 52_200,
            sessionClose: 72_000
        });
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
        new ConfigHarness(address(0), _params());
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

    /// A halt belongs to the guardian. A feed update by the admin must not lift it, and a listing
    /// cannot start one: `setAsset` keeps whatever halt is stored and ignores the one it is given.
    function test_setAsset_keepsTheStoredHalt() public {
        AssetConfig memory a = _good();
        a.haltUntil = 1_900_000_000;
        vm.prank(admin);
        config.setAsset(tokenA, a);
        assertEq(config.asset(tokenA).haltUntil, 0, "a listing cannot start a halt");

        vm.prank(admin);
        config.haltAsset(tokenA, 1_800_000_000);
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

    /// A token is never a router, listed or not. A contract that answers `allowance(address,address)` as an
    /// ERC-20 does is refused whatever else it is.
    function test_setRouter_revertsOnAnythingThatAnswersAsAToken() public {
        address[2] memory tokens = [address(new MockToken(18)), address(new NoReturnToken(6))];
        vm.startPrank(admin);
        for (uint256 i; i < tokens.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.RouterIsToken.selector, tokens[i]));
            config.setRouter(tokens[i], 1);
            assertEq(config.routerPull(tokens[i]), 0);
        }
        vm.stopPrank();
    }

    /// An asset the admin took off the list is still a token vaults may hold: it stays refused as a router.
    function test_setRouter_revertsOnARemovedAsset() public {
        _listBoth();
        vm.startPrank(admin);
        config.removeAsset(tokenA);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.RouterIsAsset.selector, tokenA));
        config.setRouter(tokenA, 1);
        vm.stopPrank();
    }

    /// Permit2 is given an allowance during a swap, and the config is where the lists live. With either as
    /// the "router", swap data could be a call on it in a vault's name.
    function test_setRouter_revertsOnPermit2AndOnTheConfigItself() public {
        vm.etch(PERMIT2, address(new MockPermit2()).code);
        address registry = address(new RouterStub());
        vm.startPrank(admin);
        config.setRegistry(registry);
        address[3] memory reserved = [PERMIT2, address(config), registry];
        for (uint256 i; i < reserved.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.RouterReserved.selector, reserved[i]));
            config.setRouter(reserved[i], 2);
            assertEq(config.routerPull(reserved[i]), 0);
        }
        vm.stopPrank();
    }

    // ---- taking an asset off the list

    function test_removeAsset_takesItOffTheListAndKeepsItsSettings() public {
        _listBoth();
        AssetConfig memory before = config.asset(tokenA);

        vm.prank(admin);
        vm.expectEmit(address(config));
        emit IVaultConfig.AssetRemoved(tokenA);
        config.removeAsset(tokenA);

        assertFalse(config.isAsset(tokenA));
        assertTrue(config.wasAsset(tokenA), "it can still be sold and withdrawn");
        assertEq(config.assets().length, 1);
        assertEq(config.assets()[0], tokenB);
        assertEq(config.removedAssets().length, 1);
        assertEq(config.removedAssets()[0], tokenA);
        _assertSame(config.asset(tokenA), before);
        assertFalse(config.wasAsset(makeAddr("never-listed")));
    }

    function test_removeAsset_listingItAgainPutsItBack() public {
        _listBoth();
        vm.startPrank(admin);
        config.removeAsset(tokenA);
        config.setAsset(tokenA, _priced(makeAddr("feedA2"), 18));
        vm.stopPrank();
        assertTrue(config.isAsset(tokenA));
        assertEq(config.removedAssets().length, 0);
        assertEq(config.assets().length, 2);
    }

    function test_removeAsset_revertsForNonAdmin() public {
        _listBoth();
        address[2] memory callers = [stranger, guardian];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, callers[i]));
            config.removeAsset(tokenA);
        }
        assertTrue(config.isAsset(tokenA));
    }

    function test_removeAsset_revertsOnATokenThatIsNotListed() public {
        _listBoth();
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.AssetNotListed.selector, router));
        config.removeAsset(router);
        config.removeAsset(tokenA);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.AssetNotListed.selector, tokenA));
        config.removeAsset(tokenA);
        vm.stopPrank();
    }

    /// The cash token is what every deposit pulls. It leaves the list only after another token has taken
    /// its place.
    function test_removeAsset_revertsOnTheCashToken() public {
        _listBoth();
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.CashTokenNotRemovable.selector, tokenB));
        config.removeAsset(tokenB);
        assertTrue(config.isAsset(tokenB));

        config.setCashToken(tokenA);
        config.removeAsset(tokenB);
        vm.stopPrank();
        assertFalse(config.isAsset(tokenB));
    }

    // ---- the three roles

    function test_roles_areTheAdminsToRotate() public {
        address next = makeAddr("next");
        vm.startPrank(admin);
        vm.expectEmit(address(config));
        emit IVaultConfig.GuardianSet(next);
        config.setGuardian(next);
        vm.expectEmit(address(config));
        emit IVaultConfig.KeeperSet(next);
        config.setKeeper(next);
        vm.expectEmit(address(config));
        emit IVaultConfig.SequencerFeedSet(next);
        config.setSequencerFeed(next);
        vm.stopPrank();
        assertEq(config.guardian(), next);
        assertEq(config.keeper(), next);
        assertEq(config.sequencerFeed(), next);

        // The guardian that was replaced is a stranger now.
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotGuardian.selector, guardian));
        config.pauseKeeper();
    }

    function test_setGuardian_revertsForNonAdmin() public {
        address[3] memory callers = [stranger, guardian, keeper];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, callers[i]));
            config.setGuardian(callers[i]);
        }
        assertEq(config.guardian(), guardian);
    }

    function test_setKeeper_revertsForNonAdmin() public {
        address[3] memory callers = [stranger, guardian, keeper];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, callers[i]));
            config.setKeeper(callers[i]);
        }
        assertEq(config.keeper(), keeper);
    }

    function test_setSequencerFeed_revertsForNonAdmin() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, guardian));
        config.setSequencerFeed(guardian);
        assertEq(config.sequencerFeed(), address(0));
    }

    // ---- the guardian: pause

    function test_pauseKeeper_byTheGuardianOrTheAdmin() public {
        address[2] memory callers = [guardian, admin];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectEmit(address(config));
            emit IVaultConfig.KeeperPaused(callers[i]);
            config.pauseKeeper();
            assertTrue(config.keeperPaused());

            vm.prank(admin);
            vm.expectEmit(address(config));
            emit IVaultConfig.KeeperUnpaused();
            config.unpauseKeeper();
            assertFalse(config.keeperPaused());
        }
    }

    function test_pauseKeeper_revertsForAnyoneElse() public {
        address[2] memory callers = [stranger, keeper];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotGuardian.selector, callers[i]));
            config.pauseKeeper();
        }
        assertFalse(config.keeperPaused());
    }

    /// The guardian can stop the keeper and cannot start it again: a leaked guardian key can only tighten.
    function test_unpauseKeeper_isTheAdminsAlone() public {
        vm.prank(guardian);
        config.pauseKeeper();
        address[3] memory callers = [guardian, keeper, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, callers[i]));
            config.unpauseKeeper();
        }
        assertTrue(config.keeperPaused());
    }

    // ---- the guardian: halting an asset

    function test_haltAsset_onlyTightens() public {
        _listBoth();
        vm.startPrank(guardian);
        vm.expectEmit(address(config));
        emit IVaultConfig.AssetHalted(tokenA, 1_800_000_000);
        config.haltAsset(tokenA, 1_800_000_000);
        assertEq(config.asset(tokenA).haltUntil, 1_800_000_000);

        uint64[2] memory notLater = [uint64(1_800_000_000), 1_799_999_999];
        for (uint256 i; i < notLater.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(IVaultConfig.OnlyTighten.selector, uint64(1_800_000_000), notLater[i])
            );
            config.haltAsset(tokenA, notLater[i]);
        }
        config.haltAsset(tokenA, 1_800_000_001);
        vm.stopPrank();
        assertEq(config.asset(tokenA).haltUntil, 1_800_000_001);
        assertEq(config.asset(tokenB).haltUntil, 0, "one asset's halt is not another's");
    }

    function test_haltAsset_revertsForAnyoneButTheGuardianOrTheAdmin() public {
        _listBoth();
        address[2] memory callers = [stranger, keeper];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotGuardian.selector, callers[i]));
            config.haltAsset(tokenA, 1_800_000_000);
        }
        assertEq(config.asset(tokenA).haltUntil, 0);
    }

    function test_haltAsset_revertsOnATokenThatWasNeverListed() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.AssetNotListed.selector, tokenA));
        config.haltAsset(tokenA, 1_800_000_000);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.AssetNotListed.selector, tokenA));
        config.setHalt(tokenA, 1_800_000_000);
        assertEq(config.asset(tokenA).haltUntil, 0);
    }

    /// A halt outlives the asset's removal and its return to the list.
    function test_haltAsset_staysThroughRemovalAndRelisting() public {
        _listBoth();
        vm.prank(guardian);
        config.haltAsset(tokenA, 1_800_000_000);
        vm.startPrank(admin);
        config.removeAsset(tokenA);
        vm.stopPrank();
        vm.prank(guardian);
        config.haltAsset(tokenA, 1_900_000_000);
        vm.prank(admin);
        config.setAsset(tokenA, _priced(makeAddr("feedA2"), 18));
        assertEq(config.asset(tokenA).haltUntil, 1_900_000_000);
    }

    /// Lifting or shortening a halt is the admin's.
    function test_setHalt_isTheAdminsAlone() public {
        _listBoth();
        vm.prank(guardian);
        config.haltAsset(tokenA, 1_800_000_000);

        address[2] memory callers = [guardian, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, callers[i]));
            config.setHalt(tokenA, 0);
        }

        vm.prank(admin);
        vm.expectEmit(address(config));
        emit IVaultConfig.AssetHalted(tokenA, 0);
        config.setHalt(tokenA, 0);
        assertEq(config.asset(tokenA).haltUntil, 0);
    }

    // ---- the guardian: the market calendar

    function test_extendClosedUntil_onlyTightens() public {
        vm.startPrank(guardian);
        vm.expectEmit(address(config));
        emit IVaultConfig.ClosedUntilSet(1_800_000_000);
        config.extendClosedUntil(1_800_000_000);
        uint64[2] memory notLater = [uint64(1_800_000_000), 1];
        for (uint256 i; i < notLater.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(IVaultConfig.OnlyTighten.selector, uint64(1_800_000_000), notLater[i])
            );
            config.extendClosedUntil(notLater[i]);
        }
        vm.stopPrank();
        assertEq(config.closedUntil(), 1_800_000_000);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotGuardian.selector, stranger));
        config.extendClosedUntil(1_900_000_000);
    }

    function test_setClosedUntil_isTheAdminsAlone() public {
        vm.prank(guardian);
        config.extendClosedUntil(1_800_000_000);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, guardian));
        config.setClosedUntil(0);

        vm.prank(admin);
        config.setClosedUntil(0);
        assertEq(config.closedUntil(), 0);
    }

    function test_closedDays_theGuardianAddsAndOnlyTheAdminRemoves() public {
        uint32 day = 20_800;
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotGuardian.selector, stranger));
        config.addClosedDay(day);
        assertFalse(config.closedDay(day));

        vm.prank(guardian);
        vm.expectEmit(address(config));
        emit IVaultConfig.ClosedDaySet(day, true);
        config.addClosedDay(day);
        assertTrue(config.closedDay(day));
        assertFalse(config.closedDay(day + 1));

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, guardian));
        config.setClosedDay(day, false);
        assertTrue(config.closedDay(day));

        vm.prank(admin);
        config.setClosedDay(day, false);
        assertFalse(config.closedDay(day));
    }

    // ---- the keeper's limits

    function test_setParams_storesThemInsideTheBounds() public {
        // The bounds themselves are allowed.
        Params memory p = Params(300, 500, 1000, 600, 0, 86_400);
        vm.prank(admin);
        vm.expectEmit(address(config));
        emit IVaultConfig.ParamsSet(p);
        config.setParams(p);
        (uint16 tolerance, uint16 lossCap, uint16 band, uint32 cooldown, uint32 open, uint32 close) = config.params();
        assertEq(tolerance, 300);
        assertEq(lossCap, 500);
        assertEq(band, 1000);
        assertEq(cooldown, 600);
        assertEq(open, 0);
        assertEq(close, 86_400);
    }

    function _expectParamsRefused(Params memory p, bytes32 param, uint256 value) internal {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.ParamOutOfBounds.selector, param, value));
        config.setParams(p);
        (uint16 tolerance,,,,,) = config.params();
        assertEq(tolerance, 125);
    }

    function test_setParams_revertsOnToleranceAbove300() public {
        Params memory p = _params();
        p.toleranceBps = 301;
        _expectParamsRefused(p, "toleranceBps", 301);
    }

    function test_setParams_revertsOnLossCapAbove500() public {
        Params memory p = _params();
        p.lossCapBps = 501;
        _expectParamsRefused(p, "lossCapBps", 501);
    }

    function test_setParams_revertsOnCooldownUnder600() public {
        Params memory p = _params();
        p.assetCooldown = 599;
        _expectParamsRefused(p, "assetCooldown", 599);
    }

    function test_setParams_revertsOnASessionPastMidnight() public {
        Params memory p = _params();
        p.sessionClose = 86_401;
        _expectParamsRefused(p, "sessionClose", 86_401);
    }

    function test_setParams_revertsOnASessionThatClosesBeforeItOpens() public {
        Params memory p = _params();
        p.sessionOpen = p.sessionClose;
        _expectParamsRefused(p, "sessionOpen", p.sessionOpen);
    }

    function test_setParams_revertsForNonAdmin() public {
        address[2] memory callers = [stranger, guardian];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, callers[i]));
            config.setParams(_params());
        }
    }

    function test_init_holdsTheParamsToTheirBounds() public {
        Params memory p = _params();
        p.assetCooldown = 0;
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.ParamOutOfBounds.selector, bytes32("assetCooldown"), 0));
        new ConfigHarness(admin, p);
    }

    // ---- the registry: set once

    function test_setRegistry_isSetOnceByTheAdmin() public {
        address registry = address(new RouterStub());
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, stranger));
        config.setRegistry(registry);

        vm.startPrank(admin);
        vm.expectEmit(address(config));
        emit IVaultConfig.RegistrySet(registry);
        config.setRegistry(registry);
        assertEq(config.registry(), registry);

        address another = address(new RouterStub());
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.RegistryAlreadySet.selector, registry));
        config.setRegistry(another);
        vm.stopPrank();
        assertEq(config.registry(), registry);
    }

    function test_setRegistry_revertsOnZero() public {
        vm.prank(admin);
        vm.expectRevert(IVaultConfig.ZeroAddress.selector);
        config.setRegistry(address(0));
    }

    function test_setRegistry_revertsOnAnAddressWithNoCode() public {
        address empty = makeAddr("no-code");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NoCode.selector, empty));
        config.setRegistry(empty);
        assertEq(config.registry(), address(0));
    }

    /// The registry is never a router. That holds whichever of the two is set first.
    function test_setRegistry_revertsOnAnAllowedRouter() public {
        vm.startPrank(admin);
        config.setRouter(router, 1);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.RouterReserved.selector, router));
        config.setRegistry(router);
        vm.stopPrank();
        assertEq(config.registry(), address(0));
    }

    // ---- launch: one-way

    function test_launch_isOneWayAndTheAdmins() public {
        address[2] memory callers = [stranger, guardian];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, callers[i]));
            config.launch();
        }
        assertFalse(config.launched());

        vm.startPrank(admin);
        vm.expectEmit(address(config));
        emit IVaultConfig.Launched();
        config.launch();
        assertTrue(config.launched());
        vm.expectRevert(IVaultConfig.AlreadyLaunched.selector);
        config.launch();
        vm.stopPrank();
        assertTrue(config.launched());
    }

    /// After launch the routers, the cash token and the feeds are still the admin's to change, by nobody
    /// else, and each change is announced.
    function test_launch_leavesRoutersCashAndFeedsWithTheAdmin() public {
        _listBoth();
        vm.prank(admin);
        config.launch();

        AssetConfig memory newFeed = _priced(makeAddr("feedA-after"), 18);
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, stranger));
        config.setRouter(router, 1);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, stranger));
        config.setCashToken(tokenA);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, stranger));
        config.setAsset(tokenA, newFeed);
        vm.stopPrank();

        vm.startPrank(admin);
        vm.expectEmit(address(config));
        emit IVaultConfig.RouterSet(router, 2);
        config.setRouter(router, 2);
        vm.expectEmit(address(config));
        emit IVaultConfig.CashTokenSet(tokenA);
        config.setCashToken(tokenA);
        vm.expectEmit(address(config));
        emit IVaultConfig.AssetSet(tokenA, newFeed);
        config.setAsset(tokenA, newFeed);
        vm.stopPrank();
        assertEq(config.asset(tokenA).feed, newFeed.feed);
    }
}
