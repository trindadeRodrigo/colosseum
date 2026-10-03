// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {IBasketVault} from "../src/interfaces/IBasketVault.sol";
import {IVaultConfig} from "../src/interfaces/IVaultConfig.sol";
import {IVaultFactory} from "../src/interfaces/IVaultFactory.sol";
import {Params, Swap, Weight} from "../src/interfaces/Types.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {ConfigHarness} from "./helpers/ConfigHarness.sol";
import {SwapFixture} from "./helpers/SwapFixture.sol";
import {MockRouter} from "./mocks/Routers.sol";
import {FeeToken, MockToken} from "./mocks/Tokens.sol";

/// A stand-in for the next version of the factory logic: the same contract with one more function.
contract VaultFactoryV2Dummy is VaultFactory {
    function version() external pure returns (uint256) {
        return 2;
    }
}

/// A config that makes a proxy outside the factory and can call its `start`: the maker is the proxy's config.
contract ProxyMaker is ConfigHarness {
    constructor(address admin_, Params memory params_) ConfigHarness(admin_, params_) {}

    function make(address beacon, address owner, bytes32 planId) external returns (BasketVault) {
        bytes memory init = abi.encodeCall(BasketVault.initialize, (owner, planId));
        return BasketVault(payable(address(new BeaconProxy(beacon, init))));
    }

    function start(BasketVault made) external {
        made.start(bytes32(0), 0, new Weight[](0), 0, new Swap[](0));
    }
}

/// The factory: who a vault belongs to, where it lives, how it is found, and who may replace the factory.
contract VaultFactoryTest is SwapFixture {
    bytes32 internal constant PLAN_2 = keccak256("plan-2");
    Weight[] internal none;
    Swap[] internal noSwaps;

    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function setUp() public {
        _deploySwapPlatform();
    }

    function _create(address as_, bytes32 salt) internal returns (address) {
        vm.prank(as_);
        return factory.createVault(salt, none, bytes32(0), 0, false);
    }

    // ---- the factory behind its proxy

    function test_initialize_setsTheAdminTheBeaconAndTheParams() public view {
        assertEq(factory.admin(), admin);
        assertEq(factory.beacon(), address(beacon));
        (uint16 tolerance, uint16 lossCap, uint16 band, uint32 cooldown, uint32 open, uint32 close) = factory.params();
        assertEq(tolerance, 125);
        assertEq(lossCap, 200);
        assertEq(band, 50);
        assertEq(cooldown, 3600);
        assertEq(open, 52_200);
        assertEq(close, 72_000);
    }

    function test_A15_initialize_revertsOnTheLogicContractAndOnTheLiveProxy() public {
        VaultFactory bareLogic = new VaultFactory();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bareLogic.initialize(stranger, address(beacon), _params());

        vm.prank(admin);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        factory.initialize(stranger, address(beacon), _params());
        assertEq(factory.admin(), admin);
    }

    function test_initialize_revertsWithoutABeacon() public {
        VaultFactory impl = new VaultFactory();
        bytes memory init = abi.encodeCall(VaultFactory.initialize, (admin, address(0), _params()));
        vm.expectRevert(IVaultConfig.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), init);

        address empty = makeAddr("no-code");
        init = abi.encodeCall(VaultFactory.initialize, (admin, empty, _params()));
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NoCode.selector, empty));
        new ERC1967Proxy(address(impl), init);
    }

    function test_initialize_holdsTheParamsToTheirBounds() public {
        VaultFactory impl = new VaultFactory();
        Params memory p = _params();
        p.toleranceBps = 301;
        bytes memory init = abi.encodeCall(VaultFactory.initialize, (admin, address(beacon), p));
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.ParamOutOfBounds.selector, bytes32("toleranceBps"), 301));
        new ERC1967Proxy(address(impl), init);
    }

    // ---- creation: the address, the owner, the lists

    function test_createVault_landsWhereVaultOfSaid() public {
        address predicted = factory.vaultOf(owner, PLAN_2);
        assertEq(predicted.code.length, 0);
        assertFalse(factory.isVault(predicted));

        vm.expectEmit(address(factory));
        emit IVaultFactory.VaultCreated(predicted, owner, PLAN_2);
        address made = _create(owner, PLAN_2);

        assertEq(made, predicted);
        assertEq(factory.vaultOf(owner, PLAN_2), made, "the same answer after it exists");
        assertGt(made.code.length, 0);
        assertEq(BasketVault(payable(made)).owner(), owner);
        assertEq(BasketVault(payable(made)).planId(), PLAN_2);
        assertEq(BasketVault(payable(made)).config(), address(factory));
        (bytes32 indexId, uint32 version, bool autoFollow) = BasketVault(payable(made)).following();
        assertEq(indexId, bytes32(0));
        assertEq(version, 0);
        assertFalse(autoFollow);
    }

    /// The app finds vaults by reading, with no event: one owner's, and all of them for the keeper.
    function test_createVault_isListed() public {
        address other = makeAddr("other-owner");
        address second = _create(owner, PLAN_2);
        address third = _create(other, PLAN_ID);

        assertEq(factory.vaultCount(), 3);
        assertEq(factory.vaultAt(0), address(vault));
        assertEq(factory.vaultAt(1), second);
        assertEq(factory.vaultAt(2), third);
        vm.expectRevert();
        factory.vaultAt(3);

        address[] memory mine = factory.vaultsOf(owner);
        assertEq(mine.length, 2);
        assertEq(mine[0], address(vault));
        assertEq(mine[1], second);
        assertEq(factory.vaultCountOf(owner), 2);
        assertEq(factory.vaultOfAt(owner, 1), second);
        assertEq(factory.vaultsOf(other).length, 1);
        assertEq(factory.vaultsOf(stranger).length, 0);

        assertTrue(factory.isVault(address(vault)));
        assertTrue(factory.isVault(second));
        assertTrue(factory.isVault(third));
        assertFalse(factory.isVault(address(logic)));
        assertFalse(factory.isVault(address(factory)));
    }

    function test_createVault_addressIsBoundToTheOwnerAndThePlan() public {
        address other = makeAddr("other-owner");
        assertTrue(factory.vaultOf(owner, PLAN_2) != factory.vaultOf(other, PLAN_2), "another owner");
        assertTrue(factory.vaultOf(owner, PLAN_2) != factory.vaultOf(owner, PLAN_ID), "another plan");
        // Another factory on the same beacon gives another address for the same owner and plan.
        assertTrue(factory.vaultOf(owner, PLAN_2) != _newFactory().vaultOf(owner, PLAN_2), "another factory");
    }

    /// The address of a vault that does not exist yet comes from the proxy's creation code, which is part of
    /// the factory's logic. A factory upgrade built with another compiler, other settings or another
    /// OpenZeppelin would carry other creation code, and `vaultOf` would move for every vault not yet made:
    /// a token sent to the old address in advance would be stranded there. This pins the code, so that such
    /// a change is seen before an upgrade is built. Vaults that exist are unaffected: their addresses are
    /// stored.
    function test_vaultOf_theProxysCreationCodeIsPinned() public pure {
        assertEq(
            keccak256(type(BeaconProxy).creationCode),
            0xa5e3e96d2fd0d717ac0a5b778f892aeeed2fdd14dca7496bcd6eeed68d4af40b,
            "the proxy's creation code changed: vaultOf moves for every vault not yet created"
        );
    }

    function test_createVault_revertsOnAPlanTheOwnerAlreadyUsed() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IVaultFactory.VaultExists.selector, address(vault)));
        factory.createVault(PLAN_ID, none, bytes32(0), 0, false);
        assertEq(factory.vaultCount(), 1);
    }

    /// Auto-follow arrives with the keeper path. Until then a vault cannot be created with it on.
    function test_createVault_refusesAutoFollow() public {
        vm.startPrank(owner);
        vm.expectRevert(IVaultFactory.AutoFollowUnavailable.selector);
        factory.createVault(PLAN_2, none, bytes32(0), 0, true);
        vm.expectRevert(IVaultFactory.AutoFollowUnavailable.selector);
        factory.createVaultAndBuy(PLAN_2, none, bytes32(0), 0, true, 0, noSwaps);
        vm.stopPrank();
        assertEq(factory.vaultOf(owner, PLAN_2).code.length, 0);
    }

    /// The owner is the caller and nothing else. A stranger who uses Alice's plan id gets a vault of their
    /// own, at another address; Alice's address stays empty and her list unchanged.
    function test_createVault_strangerCannotCreateSomeoneElsesVault() public {
        address alices = factory.vaultOf(owner, PLAN_2);

        address strangers = _create(stranger, PLAN_2);

        assertTrue(strangers != alices);
        assertEq(BasketVault(payable(strangers)).owner(), stranger);
        assertEq(alices.code.length, 0);
        assertFalse(factory.isVault(alices));
        assertEq(factory.vaultsOf(owner).length, 1);
        assertEq(factory.vaultOf(owner, PLAN_2), alices);

        // No function names an owner.
        vm.prank(stranger);
        (bool ok,) = address(factory).call(
            abi.encodeWithSignature(
                "createVaultFor(address,bytes32,(address,uint16)[],bytes32,uint32,bool)",
                owner,
                PLAN_2,
                none,
                bytes32(0),
                0,
                false
            )
        );
        assertFalse(ok);

        // Alice still gets hers, where it was promised.
        assertEq(_create(owner, PLAN_2), alices);
    }

    /// What EVM-1's reviewer did: tokens were sent to a vault's address in advance, a stranger initialised
    /// the bare proxy there and withdrew them. A vault of the factory leaves no room for it: nobody else can
    /// put code at that address, the proxy is initialised in its own constructor, and `start` is spent.
    function test_review_tokensSentInAdvance_waitForTheOwner() public {
        address alices = factory.vaultOf(owner, PLAN_2);
        stockA.mint(alices, 5 * unit);

        // A stranger's own proxy on the same beacon is somewhere else, and is not one of the factory's.
        vm.startPrank(stranger);
        bytes memory init = abi.encodeCall(BasketVault.initialize, (stranger, PLAN_2));
        address bare = address(new BeaconProxy(address(beacon), init));
        vm.stopPrank();
        assertTrue(bare != alices);
        assertFalse(factory.isVault(bare));
        assertEq(stockA.balanceOf(alices), 5 * unit);

        address made = _create(owner, PLAN_2);
        assertEq(made, alices);

        vm.startPrank(stranger);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        BasketVault(payable(made)).initialize(stranger, PLAN_2);
        vm.expectRevert(IBasketVault.NotCreating.selector);
        BasketVault(payable(made)).start(bytes32(0), 0, none, 0, noSwaps);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, stranger));
        BasketVault(payable(made)).withdraw(address(stockA), 5 * unit);
        vm.stopPrank();

        vm.prank(owner);
        BasketVault(payable(made)).withdraw(address(stockA), 5 * unit);
        assertEq(stockA.balanceOf(owner), 5 * unit);
    }

    // ---- `start`: the factory's, and only while the vault is being created

    /// After creation the factory itself is refused: the mark `initialize` left was cleared by `start`.
    function test_start_revertsForTheFactoryOnceTheVaultIsMade() public {
        vm.prank(address(factory));
        vm.expectRevert(IBasketVault.NotCreating.selector);
        vault.start(bytes32(0), 0, none, 0, noSwaps);
    }

    /// A proxy made outside the factory has its maker as its config. Even in the transaction that made it,
    /// nobody else can call `start`, and the maker only once.
    function test_start_answersOnlyTheCreatorAndOnlyOnce() public {
        ProxyMaker maker = new ProxyMaker(admin, _params());
        BasketVault bare = maker.make(address(beacon), owner, PLAN_2);
        assertEq(bare.config(), address(maker));

        address[3] memory others = [stranger, owner, address(factory)];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(IBasketVault.NotCreating.selector);
            bare.start(bytes32(0), 0, none, 0, noSwaps);
        }

        maker.start(bare);
        vm.expectRevert(IBasketVault.NotCreating.selector);
        maker.start(bare);
    }

    /// Each call here is a transaction of its own. The mark does not outlive the one that made the proxy,
    /// so a proxy whose maker did not call `start` at once can never be started.
    /// forge-config: default.isolate = true
    function test_start_revertsInAnyLaterTransaction() public {
        ProxyMaker maker = new ProxyMaker(admin, _params());
        BasketVault bare = maker.make(address(beacon), owner, PLAN_2);

        vm.expectRevert(IBasketVault.NotCreating.selector);
        maker.start(bare);
    }

    // ---- creation with the owner's own targets

    function test_createVault_storesTheOwnersTargets() public {
        Weight[] memory targets = _targets(address(stockA), 6000, address(stockB), 2500);
        address predicted = factory.vaultOf(owner, PLAN_2);

        vm.expectEmit(predicted);
        emit IBasketVault.TargetsSet(predicted, targets);
        vm.prank(owner);
        BasketVault made = BasketVault(payable(factory.createVault(PLAN_2, targets, bytes32(0), 0, false)));

        Weight[] memory stored = made.targets();
        assertEq(stored.length, 2);
        assertEq(keccak256(abi.encode(stored)), keccak256(abi.encode(targets)));
    }

    function test_createVault_revertsOnTargetsThatAreNotAllowed() public {
        Weight[] memory withCash = _targets(address(stockA), 6000, address(cash), 2500);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.InvalidTargets.selector, uint8(4)));
        factory.createVault(PLAN_2, withCash, bytes32(0), 0, false);
        assertEq(factory.vaultOf(owner, PLAN_2).code.length, 0, "nothing is left behind");
        assertEq(factory.vaultCount(), 1);
    }

    // ---- creation with the first deposit and swaps

    function test_createVaultAndBuy_depositsAndBuysInOneCall() public {
        address predicted = factory.vaultOf(owner, PLAN_2);
        Weight[] memory targets = _targets(address(stockA), 6000, address(stockB), 3000);
        Swap[] memory swaps = new Swap[](2);
        swaps[0] = _swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit);
        swaps[1] = _swap(viaPermit2, address(cash), address(stockB), 300 * USD, 2 * unit);

        vm.startPrank(owner);
        cash.approve(predicted, 1000 * USD);
        vm.expectEmit(predicted);
        emit IBasketVault.OwnerTrade(predicted, address(cash), address(stockA), 600 * USD, 3 * unit);
        vm.expectEmit(predicted);
        emit IBasketVault.OwnerTrade(predicted, address(cash), address(stockB), 300 * USD, 2 * unit);
        address made = factory.createVaultAndBuy(PLAN_2, targets, bytes32(0), 0, false, 1000 * USD, swaps);
        vm.stopPrank();

        assertEq(made, predicted);
        assertEq(cash.balanceOf(made), 100 * USD);
        assertEq(stockA.balanceOf(made), 3 * unit);
        assertEq(stockB.balanceOf(made), 2 * unit);
        assertEq(cash.balanceOf(owner), 1_000_000 * USD - 1000 * USD);
        assertEq(cash.allowance(owner, made), 0, "the owner's approval was used up");

        // Every way in adds the token to `tokens`, so `withdrawAll` leaves nothing behind.
        address[] memory tracked = BasketVault(payable(made)).tokens();
        assertEq(tracked.length, 3);
        assertEq(tracked[0], address(cash));
        assertEq(tracked[1], address(stockA));
        assertEq(tracked[2], address(stockB));

        _assertNoAllowance(made, address(cash), address(direct));
        _assertNoAllowance(made, address(cash), address(viaPermit2));

        vm.prank(owner);
        assertEq(BasketVault(payable(made)).withdrawAll().length, 0);
        assertEq(stockA.balanceOf(owner), 3 * unit);
        assertEq(stockB.balanceOf(owner), 2 * unit);
        assertEq(cash.balanceOf(made), 0);
    }

    /// The cash comes from the caller, who is the owner. Someone else's approval of the same address is not
    /// touched.
    function test_createVaultAndBuy_pullsFromTheOwnerOnly() public {
        address predicted = factory.vaultOf(owner, PLAN_2);
        cash.mint(stranger, 500 * USD);
        vm.prank(stranger);
        cash.approve(predicted, type(uint256).max);
        vm.prank(owner);
        cash.approve(predicted, 200 * USD);

        vm.prank(owner);
        factory.createVaultAndBuy(PLAN_2, none, bytes32(0), 0, false, 200 * USD, noSwaps);

        assertEq(cash.balanceOf(predicted), 200 * USD);
        assertEq(cash.balanceOf(stranger), 500 * USD);
        assertEq(cash.balanceOf(owner), 1_000_000 * USD - 200 * USD);
    }

    /// The same shortfall check as `deposit`: a cash token that skims on transfer is refused.
    function test_createVaultAndBuy_feeOnTransferCash_isRejected() public {
        FeeToken skim = new FeeToken(6, 100);
        skim.mint(owner, 1000 * USD);
        _list(address(skim), 6);
        _setCash(address(skim));
        address predicted = factory.vaultOf(owner, PLAN_2);

        vm.startPrank(owner);
        skim.approve(predicted, 1000 * USD);
        vm.expectRevert(
            abi.encodeWithSelector(IBasketVault.DepositShortfall.selector, address(skim), 1000 * USD, 990 * USD)
        );
        factory.createVaultAndBuy(PLAN_2, none, bytes32(0), 0, false, 1000 * USD, noSwaps);
        vm.stopPrank();
        assertEq(skim.balanceOf(owner), 1000 * USD);
        assertEq(predicted.code.length, 0);
    }

    /// A swap that fails takes the whole creation with it: no vault, no listing, no cash moved.
    function test_createVaultAndBuy_aFailedSwapLeavesNothing() public {
        address predicted = factory.vaultOf(owner, PLAN_2);
        Swap[] memory swaps = _swaps(_swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit));
        swaps[0].minOut = 3 * unit + 1;

        vm.startPrank(owner);
        cash.approve(predicted, 1000 * USD);
        vm.expectRevert(
            abi.encodeWithSelector(IBasketVault.ReceivedTooLittle.selector, address(stockA), 3 * unit, 3 * unit + 1)
        );
        factory.createVaultAndBuy(PLAN_2, none, bytes32(0), 0, false, 1000 * USD, swaps);
        vm.stopPrank();

        assertEq(predicted.code.length, 0);
        assertFalse(factory.isVault(predicted));
        assertEq(factory.vaultCount(), 1);
        assertEq(cash.balanceOf(owner), 1_000_000 * USD);
    }

    // ---- creation with a shared portfolio (A18)

    function _publishIndex() internal returns (bytes32 id) {
        vm.prank(stranger);
        id = registry.create(keccak256("family"), _threeStocks(), bytes32(uint256(1)), 0, 0);
    }

    function test_createVault_copiesTheActiveVersionOfASharedPortfolio() public {
        bytes32 id = _publishIndex();
        address predicted = factory.vaultOf(owner, PLAN_2);

        vm.expectEmit(predicted);
        emit IBasketVault.Followed(predicted, id, 1);
        vm.prank(owner);
        BasketVault made = BasketVault(payable(factory.createVault(PLAN_2, none, id, 1, false)));

        (bytes32 indexId, uint32 version, bool autoFollow) = made.following();
        assertEq(indexId, id);
        assertEq(version, 1);
        assertFalse(autoFollow);
        assertEq(keccak256(abi.encode(made.targets())), keccak256(abi.encode(_threeStocks())));
    }

    /// A18: the person reviewed version 1 and signed. Version 2 took effect before the transaction landed.
    /// The create fails; nothing is copied that the person did not see.
    function test_A18_createSignedAgainstAnOlderVersion_reverts() public {
        bytes32 id = _publishIndex();
        Weight[] memory next = _threeStocks();
        (next[0].bps, next[1].bps) = (next[0].bps + 500, next[1].bps - 500);
        if (next[0].bps > 5000) (next[0].bps, next[1].bps) = (next[0].bps - 1000, next[1].bps + 1000);
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.prank(stranger);
        (uint32 version, uint64 effectiveAt) = registry.publish(id, next, bytes32(uint256(2)));
        assertEq(version, 2);

        // While version 2 waits, version 1 is still the one a create must name.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.VersionMismatch.selector, id, uint32(2), uint32(1)));
        factory.createVault(PLAN_2, none, id, 2, false);

        vm.warp(effectiveAt);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.VersionMismatch.selector, id, uint32(1), uint32(2)));
        factory.createVault(PLAN_2, none, id, 1, false);
        assertEq(factory.vaultOf(owner, PLAN_2).code.length, 0);

        vm.prank(owner);
        BasketVault made = BasketVault(payable(factory.createVault(PLAN_2, none, id, 2, false)));
        assertEq(keccak256(abi.encode(made.targets())), keccak256(abi.encode(next)));
    }

    function test_createVault_revertsOnAPortfolioThatDoesNotExist() public {
        bytes32 missing = keccak256("missing");
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.IndexNotFound.selector, missing));
        factory.createVault(PLAN_2, none, missing, 1, false);
    }

    /// A shared portfolio is the targets. Naming one and also giving targets is refused.
    function test_createVault_revertsOnTargetsTogetherWithAPortfolio() public {
        bytes32 id = _publishIndex();
        Weight[] memory targets = _targets(address(stockA), 6000, address(stockB), 2500);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.InvalidTargets.selector, uint8(6)));
        factory.createVault(PLAN_2, targets, id, 1, false);
    }

    function test_createVault_revertsOnAPortfolioWhenNoRegistryIsSet() public {
        VaultFactory bare = _newFactory();
        vm.prank(owner);
        vm.expectRevert(IBasketVault.RegistryNotSet.selector);
        bare.createVault(PLAN_2, none, keccak256("any"), 1, false);
    }

    // ---- routers the factory itself rules out

    /// The beacon and every vault are part of the platform. With a vault as the "router", swap data could be
    /// one of its own functions called by another vault.
    function test_setRouter_revertsOnTheBeaconAndOnAVault() public {
        address[2] memory reserved = [address(beacon), address(vault)];
        vm.startPrank(admin);
        for (uint256 i; i < reserved.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.RouterReserved.selector, reserved[i]));
            factory.setRouter(reserved[i], 1);
            assertEq(factory.routerPull(reserved[i]), 0);
        }
        vm.stopPrank();
    }

    // ---- replacing the factory's logic (A15)

    function test_A15_upgrade_keepsStateAndIsTheAdmins() public {
        address second = _create(owner, PLAN_2);
        VaultFactoryV2Dummy v2 = new VaultFactoryV2Dummy();

        address[3] memory callers = [stranger, owner, guardian];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, callers[i]));
            factory.upgradeToAndCall(address(v2), "");
        }

        vm.prank(admin);
        factory.upgradeToAndCall(address(v2), "");

        assertEq(VaultFactoryV2Dummy(address(factory)).version(), 2);
        assertEq(address(uint160(uint256(vm.load(address(factory), ERC1967Utils.IMPLEMENTATION_SLOT)))), address(v2));
        assertEq(factory.admin(), admin);
        assertEq(factory.beacon(), address(beacon));
        assertEq(factory.vaultCount(), 2);
        assertEq(factory.vaultOf(owner, PLAN_2), second);
        assertEq(factory.cashToken(), address(cash));
        assertEq(factory.routerPull(address(viaPermit2)), 2);
        assertTrue(factory.isAsset(address(stockA)));

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        v2.initialize(stranger, address(beacon), _params());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        factory.initialize(stranger, address(beacon), _params());
    }

    /// The logic contract is not a proxy: calling its upgrade directly does nothing but revert.
    function test_upgrade_revertsOnTheLogicContractItself() public {
        VaultFactory bareLogic = new VaultFactory();
        VaultFactoryV2Dummy v2 = new VaultFactoryV2Dummy();
        vm.prank(admin);
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        bareLogic.upgradeToAndCall(address(v2), "");
    }

    function test_upgrade_revertsOnLogicThatIsNotUups() public {
        MockToken notUups = new MockToken(18);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ERC1967Utils.ERC1967InvalidImplementation.selector, address(notUups)));
        factory.upgradeToAndCall(address(notUups), "");
    }
}
