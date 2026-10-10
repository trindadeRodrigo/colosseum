// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {IndexRegistry} from "../src/IndexRegistry.sol";
import {IBasketVault} from "../src/interfaces/IBasketVault.sol";
import {IVaultConfig} from "../src/interfaces/IVaultConfig.sol";
import {AssetConfig, Params, Swap} from "../src/interfaces/Types.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {KeeperFixture} from "./helpers/KeeperFixture.sol";
import {MockFeed} from "./mocks/Feeds.sol";
import {MockRouter} from "./mocks/Routers.sol";

/// A vault logic an upgrade could bring in: its `withdraw` pays whoever calls it.
contract DrainingVaultLogic {
    function withdraw(address token, uint256 amount) external {
        (bool ok,) = token.call(abi.encodeWithSignature("transfer(address,uint256)", msg.sender, amount));
        require(ok);
    }
}

/// H1 and H2 of the review of 2026-10-09: on a mainnet the admin of the factory and the owner of the beacon
/// is OpenZeppelin's `TimelockController`, proposed to by a Safe. Everything that can change what a vault
/// does, or who may touch it, then waits out the delay, and a person whose vault it is can leave in kind
/// before it lands. The guardian alone acts at once, and can only stop things.
///
/// The platform is the keeper fixture's, with the two keys handed to a timelock of 48 hours the way the
/// deploy script does it.
contract TimelockTest is KeeperFixture {
    uint256 internal constant DELAY = 48 hours;
    bytes32 internal constant NO_PREDECESSOR = bytes32(0);

    TimelockController internal timelock;
    /// Stands for the Safe: the one proposer, canceller and executor.
    address internal safe = makeAddr("safe");
    address internal attacker = makeAddr("attacker");
    uint256 internal nonce;

    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function setUp() public {
        _deployKeeperPlatform();
        address[] memory holders = new address[](1);
        holders[0] = safe;
        timelock = new TimelockController(DELAY, holders, holders, address(0));

        vm.startPrank(admin);
        factory.proposeAdmin(address(timelock));
        beacon.transferOwnership(address(timelock));
        vm.stopPrank();
        vm.startPrank(address(timelock));
        factory.acceptAdmin();
        beacon.acceptOwnership();
        vm.stopPrank();
    }

    // ---- helpers

    function _schedule(address target, bytes memory data) internal returns (bytes32 salt) {
        salt = bytes32(++nonce);
        vm.prank(safe);
        timelock.schedule(target, 0, data, NO_PREDECESSOR, salt, DELAY);
    }

    function _execute(address target, bytes memory data, bytes32 salt) internal {
        vm.prank(safe);
        timelock.execute(target, 0, data, NO_PREDECESSOR, salt);
    }

    function _expectNotReady(address target, bytes memory data, bytes32 salt) internal {
        bytes32 id = timelock.hashOperation(target, 0, data, NO_PREDECESSOR, salt);
        // Ready is the only state `execute` accepts: bit 2 of the bitmap of states.
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockController.TimelockUnexpectedOperationState.selector, id, bytes32(uint256(1) << 2)
            )
        );
        vm.prank(safe);
        timelock.execute(target, 0, data, NO_PREDECESSOR, salt);
    }

    /// Feeds stay current across the wait, as the real ones would.
    function _wait(uint256 time) internal {
        vm.warp(vm.getBlockTimestamp() + time);
        _refresh();
    }

    /// Every call that changes what a vault does or who may touch it, with its target.
    function _guarded() internal returns (address[] memory targets, bytes[] memory calls) {
        AssetConfig memory a = factory.asset(address(stockA));
        a.feed = address(new MockFeed());
        Params memory p = _keeperParams();
        p.toleranceBps = 300;
        MockRouter router = new MockRouter(false);
        address nextFactory = address(new VaultFactory());
        address nextRegistry = address(new IndexRegistry());
        address nextVault = address(new BasketVault());

        targets = new address[](25);
        calls = new bytes[](25);
        uint256 i;
        // The settings a keeper trade is measured against (H2).
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.setKeeper, (attacker)));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.setRouter, (address(router), 1)));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.setAsset, (address(stockA), a)));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.setCashToken, (address(stockC))));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.setParams, (p)));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.setPriceDevBps, (1000)));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.setSessionPriceAge, (0)));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.setSequencerFeed, (address(0))));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.removeAsset, (address(stockC))));
        // The deposit caps and everything that lifts a stop.
        (targets[i], calls[i++]) =
            (address(factory), abi.encodeCall(IVaultConfig.setDepositCaps, (type(uint256).max, type(uint256).max)));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.unpauseKeeper, ()));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.unpauseDeposits, ()));
        // Who may create a vault.
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.setCreationRestricted, (false)));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.setCreator, (attacker, true)));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.setHalt, (address(stockA), 0)));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.setClosedUntil, (0)));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.setClosedDay, (20_800, false)));
        // The roles.
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.setGuardian, (attacker)));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.proposeAdmin, (attacker)));
        (targets[i], calls[i++]) = (address(beacon), abi.encodeCall(beacon.transferOwnership, (attacker)));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(IVaultConfig.launch, ()));
        // The code itself (H1).
        (targets[i], calls[i++]) = (address(beacon), abi.encodeCall(beacon.upgradeTo, (nextVault)));
        (targets[i], calls[i++]) = (address(factory), abi.encodeCall(factory.upgradeToAndCall, (nextFactory, "")));
        (targets[i], calls[i++]) = (address(registry), abi.encodeCall(registry.upgradeToAndCall, (nextRegistry, "")));
        (targets[i], calls[i++]) = (address(registry), abi.encodeCall(registry.setPublishDelay, (172_800)));
        assertEq(i, targets.length);
    }

    // ---- where the keys are

    function test_timelock_holdsTheAdminAndTheBeacon_andNobodyElseDoes() public view {
        assertEq(factory.admin(), address(timelock));
        assertEq(factory.pendingAdmin(), address(0));
        assertEq(beacon.owner(), address(timelock));
        assertEq(beacon.pendingOwner(), address(0));
        assertEq(timelock.getMinDelay(), DELAY);
        assertGt(address(timelock).code.length, 0, "the admin is a contract");

        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), safe));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), safe));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), safe));
        // The timelock administers its own roles: a change of proposer waits out the delay like anything else.
        assertTrue(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(timelock)));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), safe));
        // Execution is not open to anyone.
        assertFalse(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)));
        address[4] memory others = [admin, guardian, keeper, stranger];
        for (uint256 i; i < others.length; ++i) {
            assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), others[i]));
            assertFalse(timelock.hasRole(timelock.CANCELLER_ROLE(), others[i]));
            assertFalse(timelock.hasRole(timelock.EXECUTOR_ROLE(), others[i]));
            assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), others[i]));
        }
    }

    // ---- H1 and H2: every change waits

    /// Each guarded call, made directly by the Safe, by the old admin key and by a stranger: refused. The
    /// timelock is the only caller the factory, the registry and the beacon answer.
    function test_timelock_noGuardedCallCanBeMadeDirectly() public {
        (address[] memory targets, bytes[] memory calls) = _guarded();
        address[4] memory callers = [safe, admin, guardian, stranger];
        for (uint256 i; i < targets.length; ++i) {
            for (uint256 j; j < callers.length; ++j) {
                vm.prank(callers[j]);
                (bool ok, bytes memory ret) = targets[i].call(calls[i]);
                assertFalse(ok, "a guarded call went through with no delay");
                bytes4 reason = bytes4(ret);
                assertTrue(
                    reason == IVaultConfig.NotAdmin.selector || reason == Ownable.OwnableUnauthorizedAccount.selector,
                    "refused for another reason than the caller"
                );
            }
        }
    }

    /// Each guarded call, scheduled by the Safe: it cannot run a second before the delay is over, and it runs
    /// once it is. One call at a time, each from the same starting state.
    function test_timelock_everyGuardedCallWaitsOutTheDelay() public {
        // So that the three "lift a stop" calls have a stop to lift.
        vm.startPrank(guardian);
        factory.pauseKeeper();
        factory.pauseDeposits();
        vm.stopPrank();

        (address[] memory targets, bytes[] memory calls) = _guarded();
        for (uint256 i; i < targets.length; ++i) {
            uint256 snap = vm.snapshotState();
            bytes32 salt = _schedule(targets[i], calls[i]);
            _expectNotReady(targets[i], calls[i], salt);
            vm.warp(vm.getBlockTimestamp() + DELAY - 1);
            _expectNotReady(targets[i], calls[i], salt);
            vm.warp(vm.getBlockTimestamp() + 1);
            _execute(targets[i], calls[i], salt);
            vm.revertToState(snap);
        }
    }

    /// What the wait is for: the changes took effect, not only "did not revert".
    function test_timelock_afterTheDelay_theChangeIsMade() public {
        address nextVault = address(new BasketVault());
        bytes memory upgrade = abi.encodeCall(beacon.upgradeTo, (nextVault));
        bytes memory rotate = abi.encodeCall(IVaultConfig.setKeeper, (attacker));
        bytes32 saltA = _schedule(address(beacon), upgrade);
        bytes32 saltB = _schedule(address(factory), rotate);
        assertEq(beacon.implementation(), address(logic));
        assertEq(factory.keeper(), keeper);

        vm.warp(vm.getBlockTimestamp() + DELAY);
        _execute(address(beacon), upgrade, saltA);
        _execute(address(factory), rotate, saltB);
        assertEq(beacon.implementation(), nextVault);
        assertEq(factory.keeper(), attacker);
    }

    function test_timelock_onlyTheSafeSchedulesCancelsAndExecutes() public {
        bytes memory call = abi.encodeCall(IVaultConfig.setKeeper, (attacker));
        address[4] memory others = [admin, guardian, keeper, stranger];
        for (uint256 i; i < others.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector, others[i], timelock.PROPOSER_ROLE()
                )
            );
            vm.prank(others[i]);
            timelock.schedule(address(factory), 0, call, NO_PREDECESSOR, bytes32(uint256(1)), DELAY);
        }

        bytes32 salt = _schedule(address(factory), call);
        bytes32 id = timelock.hashOperation(address(factory), 0, call, NO_PREDECESSOR, salt);
        vm.warp(vm.getBlockTimestamp() + DELAY);
        for (uint256 i; i < others.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector, others[i], timelock.EXECUTOR_ROLE()
                )
            );
            vm.prank(others[i]);
            timelock.execute(address(factory), 0, call, NO_PREDECESSOR, salt);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector, others[i], timelock.CANCELLER_ROLE()
                )
            );
            vm.prank(others[i]);
            timelock.cancel(id);
        }

        // The Safe takes a queued change back: it can then never run.
        vm.prank(safe);
        timelock.cancel(id);
        _expectNotReady(address(factory), call, salt);
        assertEq(factory.keeper(), keeper);
    }

    /// The delay cannot be skipped by asking for a shorter one, and it cannot be shortened except by a
    /// change that itself waits out the delay in force.
    function test_timelock_theDelayCannotBeCutShort() public {
        bytes memory call = abi.encodeCall(IVaultConfig.setKeeper, (attacker));
        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockInsufficientDelay.selector, DELAY - 1, DELAY));
        vm.prank(safe);
        timelock.schedule(address(factory), 0, call, NO_PREDECESSOR, bytes32(uint256(1)), DELAY - 1);

        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockUnauthorizedCaller.selector, safe));
        vm.prank(safe);
        timelock.updateDelay(0);

        bytes memory shorten = abi.encodeCall(timelock.updateDelay, (0));
        bytes32 salt = _schedule(address(timelock), shorten);
        vm.warp(vm.getBlockTimestamp() + DELAY - 1);
        _expectNotReady(address(timelock), shorten, salt);
        assertEq(timelock.getMinDelay(), DELAY);

        // And the Safe cannot give itself, or anyone, the timelock's own admin role.
        bytes32 adminRole = timelock.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, safe, adminRole)
        );
        vm.prank(safe);
        timelock.grantRole(adminRole, safe);
    }

    // ---- the guardian: at once, and only to stop

    function test_guardian_stopsAtOnce_withNoDelay() public {
        vm.startPrank(guardian);
        factory.pauseKeeper();
        factory.pauseDeposits();
        factory.haltAsset(address(stockA), uint64(vm.getBlockTimestamp() + 30 days));
        factory.extendClosedUntil(uint64(vm.getBlockTimestamp() + 1 days));
        factory.addClosedDay(uint32(vm.getBlockTimestamp() / 1 days));
        vm.stopPrank();
        assertTrue(factory.keeperPaused());
        assertTrue(factory.depositsPaused());

        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0), abi.encodeWithSelector(IBasketVault.KeeperPaused.selector)
        );
        vm.expectRevert(IVaultConfig.DepositsArePaused.selector);
        vm.prank(owner);
        vault.deposit(1 * USD);
    }

    /// The guardian cannot lift a stop, change a setting, take a role, upgrade anything, reach the
    /// timelock, or move a token. Lifting what it stopped is the admin's, after the delay.
    function test_guardian_canOnlyStop() public {
        vm.startPrank(guardian);
        factory.pauseKeeper();
        factory.pauseDeposits();
        vm.stopPrank();

        (address[] memory targets, bytes[] memory calls) = _guarded();
        for (uint256 i; i < targets.length; ++i) {
            vm.prank(guardian);
            (bool ok,) = targets[i].call(calls[i]);
            assertFalse(ok, "the guardian made an admin's call");
        }
        assertTrue(factory.keeperPaused());
        assertTrue(factory.depositsPaused());

        // It is nobody to a vault.
        Swap memory buy = _buy(direct, address(stockA), 4000 * USD, 0);
        vm.startPrank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, guardian));
        vault.withdraw(address(cash), 1);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, guardian));
        vault.withdrawAll();
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, guardian));
        vault.deposit(1);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotKeeper.selector, guardian));
        vault.keeperSwap(buy);
        vm.stopPrank();
        assertEq(cash.balanceOf(address(vault)), START);

        // A guardian call can only be later, never earlier: it cannot undo its own halt.
        vm.startPrank(guardian);
        factory.haltAsset(address(stockA), 2_000_000_000);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.OnlyTighten.selector, 2_000_000_000, 1));
        factory.haltAsset(address(stockA), 1);
        vm.stopPrank();
    }

    // ---- the promise: no stop and no pending change blocks the way out in kind

    /// Everything the guardian can stop is stopped, the market is closed for good, and an upgrade that
    /// would drain every vault is queued. The owner still takes each token out as it is, and all of them
    /// at once.
    function test_pause_neverBlocksAnOwnersWithdrawalInKind() public {
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 0));
        uint256 stockHeld = stockA.balanceOf(address(vault));
        uint256 cashHeld = cash.balanceOf(address(vault));
        assertGt(stockHeld, 0);

        vm.startPrank(guardian);
        factory.pauseKeeper();
        factory.pauseDeposits();
        factory.haltAsset(address(stockA), type(uint64).max);
        factory.extendClosedUntil(type(uint64).max);
        vm.stopPrank();
        _schedule(address(beacon), abi.encodeCall(beacon.upgradeTo, (address(new DrainingVaultLogic()))));
        // No new money, and that is all the deposit pause does.
        vm.expectRevert(IVaultConfig.DepositsArePaused.selector);
        vm.prank(owner);
        vault.deposit(1 * USD);

        uint256 ownerCash = cash.balanceOf(owner);
        vm.startPrank(owner);
        vault.withdraw(address(stockA), stockHeld / 2);
        vault.withdraw(address(cash), 1000 * USD);
        // A sale to cash is the owner's too: a pause is not a lock on what the vault already holds.
        vault.ownerSwap(_swaps(_sell(direct, address(stockA), stockHeld / 4, 0)), LATER);
        address[] memory skipped = vault.withdrawAll();
        vm.stopPrank();

        assertEq(skipped.length, 0);
        assertEq(stockA.balanceOf(address(vault)), 0);
        assertEq(cash.balanceOf(address(vault)), 0);
        assertEq(stockA.balanceOf(owner), stockHeld - stockHeld / 4, "the stock, in kind");
        assertEq(cash.balanceOf(owner), ownerCash + cashHeld + _valueOf(address(stockA), stockHeld / 4));
    }

    /// A vault created while deposits are paused is still created, empty; and creating one with a first
    /// deposit is refused as a whole.
    function test_pause_stopsTheFirstDepositOfACreation_andNothingElseOfIt() public {
        vm.prank(guardian);
        factory.pauseDeposits();
        vm.startPrank(stranger);
        address made = factory.createVault(
            keccak256("empty"), _targets(address(stockA), 4000, address(stockB), 3000), bytes32(0), 0, false
        );
        assertTrue(factory.isVault(made));
        cash.mint(stranger, 100 * USD);
        cash.approve(factory.vaultOf(stranger, keccak256("funded")), 100 * USD);
        vm.expectRevert(IVaultConfig.DepositsArePaused.selector);
        factory.createVaultAndBuy(
            keccak256("funded"),
            _targets(address(stockA), 4000, address(stockB), 3000),
            bytes32(0),
            0,
            false,
            100 * USD,
            new Swap[](0),
            LATER
        );
        vm.stopPrank();
    }

    // ---- H1: an upgrade that would take everything gives two days' notice

    /// The Safe is stolen and queues a vault logic that pays out to any caller. Before: one transaction.
    /// Now: it sits in the timelock for 48 hours, where anyone can read it, and the owner leaves in kind.
    function test_H1_aHostileUpgradeWaits_andTheOwnerLeavesFirst() public {
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 0));
        uint256 stockHeld = stockA.balanceOf(address(vault));
        address drain = address(new DrainingVaultLogic());
        bytes memory upgrade = abi.encodeCall(beacon.upgradeTo, (drain));

        // With no timelock in the way this call is the whole attack. It is refused.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, safe));
        vm.prank(safe);
        beacon.upgradeTo(drain);

        bytes32 salt = _schedule(address(beacon), upgrade);
        bytes32 id = timelock.hashOperation(address(beacon), 0, upgrade, NO_PREDECESSOR, salt);
        assertTrue(timelock.isOperationPending(id), "the queued upgrade can be read on chain");
        assertEq(timelock.getTimestamp(id), vm.getBlockTimestamp() + DELAY, "and when it may land");

        // A day and a half later the owner has seen it.
        vm.warp(vm.getBlockTimestamp() + 36 hours);
        vm.prank(owner);
        vault.withdrawAll();
        assertEq(stockA.balanceOf(owner), stockHeld);

        vm.warp(vm.getBlockTimestamp() + 12 hours);
        _execute(address(beacon), upgrade, salt);
        uint256 before = cash.balanceOf(attacker);
        vm.prank(attacker);
        DrainingVaultLogic(address(vault)).withdraw(address(cash), cash.balanceOf(address(vault)));
        assertEq(cash.balanceOf(attacker), before, "nothing was left to take");
    }

    // ---- H2: what the admin reaches in an auto-follow vault by settings alone, stated as it is

    /// The admin needs no upgrade to empty most of an auto-follow vault: it names itself keeper, lists its
    /// own router, and points each target at a feed that prices it 100,000 times too high. One keeper trade
    /// per target then spends the target's whole share of the cash for a hundred-thousandth of the tokens,
    /// and every check passes at the false price. Nothing in the contract bounds this; what bounds it now is
    /// time. The four settings wait 48 hours in the timelock.
    function test_H2_settingsAloneDrainAnAutoFollowVault_butOnlyAfterTheDelay() public {
        (address[] memory targets, bytes[] memory calls, MockRouter evil) = _settingsAttack();
        bytes32 salt = bytes32(++nonce);
        uint256[] memory values = new uint256[](targets.length);
        vm.prank(safe);
        timelock.scheduleBatch(targets, values, calls, NO_PREDECESSOR, salt, DELAY);

        // During the wait the attack does not exist: the attacker is nobody, its router is not listed.
        Swap memory steal = _swap(evil, address(cash), address(stockA), 4000 * USD, 0.0004e18);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotKeeper.selector, attacker));
        vm.prank(attacker);
        vault.keeperSwap(steal);

        _wait(DELAY);
        vm.prank(safe);
        timelock.executeBatch(targets, values, calls, NO_PREDECESSOR, salt);

        // 40% and 30% of $10,000, for tokens worth four and three cents.
        vm.startPrank(attacker);
        vault.keeperSwap(steal);
        vault.keeperSwap(_swap(evil, address(cash), address(stockB), 3000 * USD, 0.0006e18));
        vm.stopPrank();
        assertEq(cash.balanceOf(address(evil)), 7000 * USD, "the admin's router holds 70% of the vault");
        assertEq(cash.balanceOf(address(vault)), 3000 * USD);
        assertEq(stockA.balanceOf(address(vault)), 0.0004e18);
        assertEq(vault.snapshot().lossUsedBps, 0, "and the weekly loss counter saw nothing");
    }

    /// The same attack against an owner who read the queue: they leave, or switch auto-follow off, inside the
    /// two days, and the settings land on nothing.
    function test_H2_theOwnerWhoLeavesOrSwitchesOffInTime_losesNothing() public {
        BasketVault stays = _createVault(stranger, keccak256("stays"));
        cash.mint(stranger, START);
        vm.startPrank(stranger);
        cash.approve(address(stays), START);
        stays.deposit(START);
        stays.setTargets(_targets(address(stockA), TARGET_A, address(stockB), TARGET_B));
        stays.setAutoFollow(true);
        vm.stopPrank();

        (address[] memory targets, bytes[] memory calls, MockRouter evil) = _settingsAttack();
        bytes32 salt = bytes32(++nonce);
        uint256[] memory values = new uint256[](targets.length);
        vm.prank(safe);
        timelock.scheduleBatch(targets, values, calls, NO_PREDECESSOR, salt, DELAY);

        vm.warp(vm.getBlockTimestamp() + 24 hours);
        vm.prank(owner);
        vault.withdrawAll();
        vm.prank(stranger);
        stays.setAutoFollow(false);

        _wait(24 hours);
        vm.prank(safe);
        timelock.executeBatch(targets, values, calls, NO_PREDECESSOR, salt);

        Swap memory steal = _swap(evil, address(cash), address(stockA), 4000 * USD, 0.0004e18);
        vm.startPrank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.AutoFollowOff.selector));
        stays.keeperSwap(steal);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotTowardTarget.selector, address(stockA)));
        vault.keeperSwap(steal);
        vm.stopPrank();
        assertEq(cash.balanceOf(owner), 1_000_000 * USD, "the one who left has everything");
        assertEq(cash.balanceOf(address(stays)), START, "the one who switched auto-follow off kept the vault whole");
        assertEq(cash.balanceOf(address(evil)), 0);
    }

    /// The four settings of the attack: the keeper, a router of the attacker's, and both targets repriced
    /// 100,000 times too high inside a range the admin sets itself.
    function _settingsAttack() internal returns (address[] memory targets, bytes[] memory calls, MockRouter evil) {
        evil = new MockRouter(false);
        stockA.mint(address(evil), 1e18);
        stockB.mint(address(evil), 1e18);
        targets = new address[](4);
        calls = new bytes[](4);
        for (uint256 i; i < 4; ++i) {
            targets[i] = address(factory);
        }
        calls[0] = abi.encodeCall(IVaultConfig.setKeeper, (attacker));
        calls[1] = abi.encodeCall(IVaultConfig.setRouter, (address(evil), 1));
        calls[2] = abi.encodeCall(IVaultConfig.setAsset, (address(stockA), _falsePrice(PRICE_A * 100_000)));
        calls[3] = abi.encodeCall(IVaultConfig.setAsset, (address(stockB), _falsePrice(PRICE_B * 100_000)));
    }

    function _falsePrice(uint256 price) internal returns (AssetConfig memory a) {
        MockFeed spot = new MockFeed();
        MockFeed average = new MockFeed();
        // Stamped far enough ahead to be current when the settings land.
        spot.set(int256(price), vm.getBlockTimestamp() + DELAY);
        average.set(int256(price), vm.getBlockTimestamp() + DELAY);
        a = _keeperAsset(spot, average, price, 1);
    }
}
