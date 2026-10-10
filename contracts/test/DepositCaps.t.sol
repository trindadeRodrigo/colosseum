// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {BasketVault} from "../src/BasketVault.sol";
import {IVaultConfig} from "../src/interfaces/IVaultConfig.sol";
import {Swap, Weight} from "../src/interfaces/Types.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {SwapFixture} from "./helpers/SwapFixture.sol";

/// The deposit caps: what one vault and what all vaults of a factory may take in, where the admin sets
/// one. None is set unless it does (gate `NO-DEPOSIT-CAP`, Thom, 2026-10-10): a cap of zero is no cap, on a
/// new factory and on an upgraded one, and what closes deposits is the guardian's pause, never a number.
///
/// What is counted, exactly: cash that came in through `deposit` or at creation, less cash that left
/// through `withdraw` or `withdrawAll`, never below zero, per vault; the total is the sum over vaults as each
/// last reported it. No price is read. So the caps bound money in, not what the holdings are worth now, and
/// two things are stated here as they are rather than hidden:
///   - a vault that leaves in kind keeps its count until it is empty, so it errs toward refusing;
///   - a token sent straight to a vault's address is not a deposit and is not counted, and no contract can
///     refuse it.
contract DepositCapsTest is SwapFixture {
    uint256 internal constant CAP = 10_000 * USD;
    address internal second = makeAddr("second-person");
    BasketVault internal other;

    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function setUp() public {
        _deploySwapPlatform();
        other = _createVault(second, keccak256("plan-2"));
        cash.mint(second, 1_000_000 * USD);
        vm.prank(second);
        cash.approve(address(other), type(uint256).max);
    }

    function _caps(uint256 perVault, uint256 total) internal {
        vm.prank(admin);
        factory.setDepositCaps(perVault, total);
    }

    function _deposit(BasketVault vault_, uint256 amount) internal {
        vm.prank(vault_.owner());
        vault_.deposit(amount);
    }

    function _expectDepositRevert(BasketVault vault_, uint256 amount, bytes memory err) internal {
        address who = vault_.owner();
        vm.expectRevert(err);
        vm.prank(who);
        vault_.deposit(amount);
    }

    // ---- the setting

    /// No cap is the start: both read zero, zero is "none", and any amount comes in.
    function test_caps_aNewFactoryHasNone_untilTheAdminSetsThem() public {
        (uint256 perVault, uint256 total) = factory.depositCaps();
        assertEq(perVault, 0);
        assertEq(total, 0);
        assertEq(factory.totalDeposited(), 0);
        assertFalse(factory.depositsPaused());
        _deposit(vault, 900_000 * USD);
        _deposit(other, 900_000 * USD);
        assertEq(factory.totalDeposited(), 1_800_000 * USD, "counted all the same, for a cap set later");
    }

    /// Either cap alone: the other stays "none".
    function test_caps_oneCanBeSetWithoutTheOther() public {
        _caps(CAP, 0);
        _deposit(vault, CAP);
        _expectDepositRevert(
            vault, 1, abi.encodeWithSelector(IVaultConfig.VaultCapReached.selector, address(vault), CAP + 1, CAP)
        );
        _deposit(other, CAP);
        assertEq(factory.totalDeposited(), 2 * CAP, "no total cap: every vault may fill its own");

        _caps(0, 3 * CAP);
        _deposit(vault, CAP);
        _expectDepositRevert(
            other, 1, abi.encodeWithSelector(IVaultConfig.TotalCapReached.selector, 3 * CAP + 1, 3 * CAP)
        );
    }

    /// A cap taken away again is gone: zero does not close deposits, it opens them.
    function test_caps_setBackToZero_areNoCapAgain() public {
        _caps(CAP, CAP);
        _deposit(vault, CAP);
        _expectDepositRevert(
            vault, 1, abi.encodeWithSelector(IVaultConfig.VaultCapReached.selector, address(vault), CAP + 1, CAP)
        );
        vm.expectEmit(address(factory));
        emit IVaultConfig.DepositCapsSet(0, 0);
        _caps(0, 0);
        _deposit(vault, 50 * CAP);
        _deposit(other, 50 * CAP);
        assertEq(vault.netDeposited(), 51 * CAP);
    }

    function test_setDepositCaps_isTheAdminsOnly() public {
        address[4] memory others = [guardian, keeper, owner, stranger];
        for (uint256 i; i < others.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, others[i]));
            vm.prank(others[i]);
            factory.setDepositCaps(1, 1);
        }
        vm.expectEmit(address(factory));
        emit IVaultConfig.DepositCapsSet(CAP, 3 * CAP);
        _caps(CAP, 3 * CAP);
        (uint256 perVault, uint256 total) = factory.depositCaps();
        assertEq(perVault, CAP);
        assertEq(total, 3 * CAP);
    }

    /// One vault can never be allowed more than all of them, where both are capped.
    function test_setDepositCaps_refusesAVaultCapAboveTheTotal() public {
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.ParamOutOfBounds.selector, bytes32("vaultCap"), CAP + 1));
        vm.prank(admin);
        factory.setDepositCaps(CAP + 1, CAP);
        // With no total, a vault's cap has nothing to be above.
        _caps(CAP + 1, 0);
        _caps(0, CAP);
        _caps(CAP, CAP);
    }

    /// Stopping new money is the guardian's, or the admin's; lifting the stop is the admin's alone.
    function test_pauseDeposits_isTheGuardiansOrTheAdmins_andOnlyTheAdminLiftsIt() public {
        address[3] memory others = [keeper, owner, stranger];
        for (uint256 i; i < others.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotGuardian.selector, others[i]));
            vm.prank(others[i]);
            factory.pauseDeposits();
        }
        vm.expectEmit(address(factory));
        emit IVaultConfig.DepositsPaused(guardian);
        vm.prank(guardian);
        factory.pauseDeposits();
        assertTrue(factory.depositsPaused());
        _expectDepositRevert(vault, 1, abi.encodeWithSelector(IVaultConfig.DepositsArePaused.selector));

        address[4] memory notAdmin = [guardian, keeper, owner, stranger];
        for (uint256 i; i < notAdmin.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, notAdmin[i]));
            vm.prank(notAdmin[i]);
            factory.unpauseDeposits();
        }
        vm.prank(admin);
        factory.unpauseDeposits();
        assertFalse(factory.depositsPaused());
        _deposit(vault, 1);
        vm.prank(admin);
        factory.pauseDeposits();
        assertTrue(factory.depositsPaused());
    }

    // ---- the cap of one vault

    function test_vaultCap_holdsEveryDeposit_andCanBeRaised() public {
        _caps(CAP, 5 * CAP);
        _deposit(vault, 6000 * USD);
        _deposit(vault, 4000 * USD);
        assertEq(vault.netDeposited(), CAP);
        assertEq(factory.depositedOf(address(vault)), CAP);

        _expectDepositRevert(
            vault, 1, abi.encodeWithSelector(IVaultConfig.VaultCapReached.selector, address(vault), CAP + 1, CAP)
        );
        assertEq(cash.balanceOf(address(vault)), CAP, "a refused deposit moved nothing");

        // Another vault has its own count.
        _deposit(other, CAP);

        _caps(2 * CAP, 5 * CAP);
        _deposit(vault, CAP);
        assertEq(vault.netDeposited(), 2 * CAP);
    }

    // ---- the cap of all vaults together

    function test_totalCap_holdsAcrossVaults_andCanBeRaised() public {
        _caps(CAP, CAP);
        _deposit(vault, 7000 * USD);
        _deposit(other, 3000 * USD);
        assertEq(factory.totalDeposited(), CAP);

        _expectDepositRevert(other, 1, abi.encodeWithSelector(IVaultConfig.TotalCapReached.selector, CAP + 1, CAP));
        _expectDepositRevert(vault, 1, abi.encodeWithSelector(IVaultConfig.TotalCapReached.selector, CAP + 1, CAP));

        _caps(CAP, 2 * CAP);
        _deposit(other, 7000 * USD);
        assertEq(factory.totalDeposited(), 17_000 * USD);
        assertEq(factory.depositedOf(address(other)), CAP);
    }

    /// The first deposit of a creation is a deposit like any other.
    function test_caps_holdTheFirstDepositOfACreation() public {
        _caps(CAP, CAP);
        _deposit(vault, 9000 * USD);
        bytes32 salt = keccak256("plan-3");
        Weight[] memory none = new Weight[](0);
        Swap[] memory noSwaps = new Swap[](0);
        vm.startPrank(second);
        cash.approve(factory.vaultOf(second, salt), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.TotalCapReached.selector, CAP + 1, CAP));
        factory.createVaultAndBuy(salt, none, bytes32(0), 0, false, 1000 * USD + 1, noSwaps, LATER);
        address made = factory.createVaultAndBuy(salt, none, bytes32(0), 0, false, 1000 * USD, noSwaps, LATER);
        vm.stopPrank();
        assertEq(factory.depositedOf(made), 1000 * USD);
        assertEq(factory.totalDeposited(), CAP);
    }

    // ---- the way out is never capped

    /// With both caps set as low as a cap goes, far under what the vault already holds: nothing more comes
    /// in, and everything still goes out.
    function test_caps_neverReachAWithdrawal() public {
        _deposit(vault, 5000 * USD);
        vm.prank(owner);
        vault.ownerSwap(_swaps(_swap(direct, address(cash), address(stockA), 2000 * USD, 20 * unit)), LATER);
        _caps(1, 1);

        _expectDepositRevert(
            vault, 1, abi.encodeWithSelector(IVaultConfig.VaultCapReached.selector, address(vault), 5000 * USD + 1, 1)
        );
        vm.startPrank(owner);
        vault.withdraw(address(cash), 1000 * USD);
        vault.withdraw(address(stockA), 5 * unit);
        // A sale is not a deposit: the cash it brings is not held to the cap.
        vault.ownerSwap(_swaps(_swap(direct, address(stockA), address(cash), 5 * unit, 500 * USD)), LATER);
        address[] memory skipped = vault.withdrawAll();
        vm.stopPrank();
        assertEq(skipped.length, 0);
        assertEq(cash.balanceOf(address(vault)), 0);
        assertEq(stockA.balanceOf(address(vault)), 0);
    }

    // ---- what is counted

    function test_count_isCashInLessCashOut() public {
        _caps(CAP, CAP);
        _deposit(vault, 6000 * USD);
        vm.prank(owner);
        vault.withdraw(address(cash), 4000 * USD);
        assertEq(vault.netDeposited(), 2000 * USD);

        // The room that came back can be used again, to the cap and no further.
        _deposit(vault, 8000 * USD);
        assertEq(vault.netDeposited(), CAP);
        _expectDepositRevert(
            vault, 1, abi.encodeWithSelector(IVaultConfig.VaultCapReached.selector, address(vault), CAP + 1, CAP)
        );
    }

    /// Cash a sale brought in can leave as well; the count stops at zero and does not go below.
    function test_count_stopsAtZero_whenMoreCashLeavesThanCameIn() public {
        _deposit(vault, 1000 * USD);
        vm.startPrank(owner);
        vault.ownerSwap(_swaps(_swap(direct, address(cash), address(stockA), 1000 * USD, 10 * unit)), LATER);
        vault.ownerSwap(_swaps(_swap(direct, address(stockA), address(cash), 10 * unit, 1500 * USD)), LATER);
        vault.withdraw(address(cash), 1200 * USD);
        vm.stopPrank();
        assertEq(vault.netDeposited(), 0);
        _caps(CAP, CAP);
        _deposit(vault, CAP);
        assertEq(vault.netDeposited(), CAP);
    }

    /// Deposit, swap, withdraw in kind. The count is of cash, so the stock that left is not seen: the vault
    /// still counts at its cap and takes no more. That is the limit of counting without a price, and it
    /// errs toward refusing: this sequence cannot be used to hold more than the cap of deposited money.
    function test_count_depositSwapWithdrawInKind_leavesTheCountWhereItWas() public {
        _caps(CAP, CAP);
        _deposit(vault, CAP);
        vm.startPrank(owner);
        vault.ownerSwap(_swaps(_swap(direct, address(cash), address(stockA), CAP, 100 * unit)), LATER);
        vault.withdraw(address(stockA), 99 * unit);
        vm.stopPrank();

        assertEq(vault.netDeposited(), CAP, "the stock that left was not counted out");
        _expectDepositRevert(
            vault, 1, abi.encodeWithSelector(IVaultConfig.VaultCapReached.selector, address(vault), CAP + 1, CAP)
        );
        // Selling what is left and taking the cash does count.
        vm.startPrank(owner);
        vault.ownerSwap(_swaps(_swap(direct, address(stockA), address(cash), 1 * unit, 100 * USD)), LATER);
        vault.withdraw(address(cash), 100 * USD);
        vm.stopPrank();
        assertEq(vault.netDeposited(), CAP - 100 * USD);
    }

    /// Once a sweep has left nothing behind, the vault holds none of what it took in: its count is zero.
    function test_count_isZeroOnceTheVaultIsEmptied() public {
        _caps(CAP, CAP);
        _deposit(vault, CAP);
        vm.startPrank(owner);
        vault.ownerSwap(_swaps(_swap(direct, address(cash), address(stockA), CAP, 100 * unit)), LATER);
        address[] memory skipped = vault.withdrawAll();
        vm.stopPrank();
        assertEq(skipped.length, 0);
        assertEq(vault.netDeposited(), 0);
        _deposit(vault, CAP);
    }

    /// With one token frozen and left behind, the sweep counts out only the cash that left.
    function test_count_afterASweepThatSkippedAToken() public {
        _deposit(vault, 5000 * USD);
        vm.prank(owner);
        vault.ownerSwap(_swaps(_swap(direct, address(cash), address(stockA), 2000 * USD, 20 * unit)), LATER);
        vm.mockCallRevert(address(stockA), abi.encodeWithSignature("transfer(address,uint256)"), "frozen");
        vm.prank(owner);
        address[] memory skipped = vault.withdrawAll();
        assertEq(skipped.length, 1);
        assertEq(vault.netDeposited(), 2000 * USD, "5,000 in, 3,000 of cash out, the stock still inside");
    }

    /// A token sent to the vault from outside is not a deposit. Nothing can refuse it, and the cap does not
    /// see it: stated, not solved.
    function test_count_doesNotSeeATransferFromOutside() public {
        _caps(CAP, CAP);
        _deposit(vault, CAP);
        cash.mint(address(vault), 5000 * USD);
        assertEq(cash.balanceOf(address(vault)), 15_000 * USD);
        assertEq(vault.netDeposited(), CAP);
        // Taking it out again lowers the count like any cash: the count never goes up without a deposit.
        vm.prank(owner);
        vault.withdraw(address(cash), 5000 * USD);
        assertEq(vault.netDeposited(), 5000 * USD);
    }

    // ---- the total between deposits

    /// A withdrawal tells the factory nothing (it calls nothing), so the total still holds what a vault
    /// last reported until that vault deposits again or anyone asks the factory to look.
    function test_sync_bringsTheTotalDownToWhatVaultsHoldNow() public {
        _caps(CAP, CAP);
        _deposit(vault, CAP);
        vm.prank(owner);
        vault.withdraw(address(cash), CAP);
        assertEq(vault.netDeposited(), 0);
        assertEq(factory.totalDeposited(), CAP, "not seen yet");
        _expectDepositRevert(other, 1, abi.encodeWithSelector(IVaultConfig.TotalCapReached.selector, CAP + 1, CAP));

        address[] memory list = new address[](2);
        list[0] = address(vault);
        list[1] = address(other);
        vm.expectEmit(address(factory));
        emit IVaultConfig.DepositCounted(address(vault), 0, 0);
        vm.prank(stranger);
        factory.syncDeposits(list);
        assertEq(factory.totalDeposited(), 0);
        assertEq(factory.depositedOf(address(vault)), 0);
        _deposit(other, CAP);
    }

    /// The vault's own next deposit brings its count up to date without anyone's help.
    function test_sync_isNotNeededForTheVaultsOwnNextDeposit() public {
        _caps(CAP, CAP);
        _deposit(vault, CAP);
        vm.prank(owner);
        vault.withdraw(address(cash), 9000 * USD);
        _deposit(vault, 2000 * USD);
        assertEq(factory.depositedOf(address(vault)), 3000 * USD);
        assertEq(factory.totalDeposited(), 3000 * USD);
    }

    function test_sync_refusesAnAddressThatIsNotAVault() public {
        address[] memory list = new address[](1);
        list[0] = address(cash);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAVault.selector, address(cash)));
        factory.syncDeposits(list);
    }

    /// Only a vault of this factory can report a deposit: nobody can move the total by calling it.
    function test_noteDeposit_isAVaultsOnly() public {
        address[5] memory others = [admin, guardian, keeper, owner, stranger];
        for (uint256 i; i < others.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAVault.selector, others[i]));
            vm.prank(others[i]);
            factory.noteDeposit(0);
        }
        // A vault of another factory on the same beacon is not one of this factory's.
        VaultFactory elsewhere = _newFactory();
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAVault.selector, address(vault)));
        vm.prank(address(vault));
        elsewhere.noteDeposit(0);
    }

    // ---- who may create a vault

    function test_creation_isOpenToAnyone_untilTheAdminRestrictsIt() public {
        assertFalse(factory.creationRestricted());
        assertTrue(factory.mayCreate(stranger));
        _createVault(stranger, keccak256("anyone"));
    }

    function test_creation_theListIsTheAdminsOnly() public {
        address[4] memory others = [guardian, keeper, owner, stranger];
        for (uint256 i; i < others.length; ++i) {
            vm.startPrank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, others[i]));
            factory.setCreationRestricted(true);
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, others[i]));
            factory.setCreator(others[i], true);
            vm.stopPrank();
        }
        vm.startPrank(admin);
        vm.expectRevert(IVaultConfig.ZeroAddress.selector);
        factory.setCreator(address(0), true);
        vm.expectEmit(address(factory));
        emit IVaultConfig.CreatorSet(second, true);
        factory.setCreator(second, true);
        vm.expectEmit(address(factory));
        emit IVaultConfig.CreationRestrictedSet(true);
        factory.setCreationRestricted(true);
        vm.stopPrank();
        assertTrue(factory.creationRestricted());
        assertTrue(factory.mayCreate(second));
        assertFalse(factory.mayCreate(stranger));
    }

    /// Restricted: only the listed create, by either way of creating. A vault that already exists is not
    /// touched: its owner, listed or not, still deposits and withdraws.
    function test_creation_restricted_onlyTheListedCreate_andExistingVaultsAreUntouched() public {
        vm.startPrank(admin);
        factory.setCreator(second, true);
        factory.setCreationRestricted(true);
        vm.stopPrank();

        Weight[] memory none = new Weight[](0);
        Swap[] memory noSwaps = new Swap[](0);
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAllowedToCreate.selector, stranger));
        factory.createVault(keccak256("a"), none, bytes32(0), 0, false);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAllowedToCreate.selector, stranger));
        factory.createVaultAndBuy(keccak256("b"), none, bytes32(0), 0, false, 0, noSwaps, LATER);
        vm.stopPrank();
        vm.prank(second);
        address made = factory.createVault(keccak256("c"), none, bytes32(0), 0, false);
        assertTrue(factory.isVault(made));

        // The fixture's owner is not on the list, and their vault is theirs as before.
        assertFalse(factory.mayCreate(owner));
        _deposit(vault, 100 * USD);
        vm.prank(owner);
        vault.withdrawAll();

        // Off the list again, and open again.
        vm.prank(admin);
        factory.setCreator(second, false);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAllowedToCreate.selector, second));
        vm.prank(second);
        factory.createVault(keccak256("d"), none, bytes32(0), 0, false);
        vm.prank(admin);
        factory.setCreationRestricted(false);
        _createVault(stranger, keccak256("e"));
    }

    /// What the list is for. A stranger uses up the whole total for the price of a swap: deposit to the
    /// cap, swap, take the stock out with `withdraw`. The count stays, and nobody can deposit until the
    /// admin raises the cap. With creation restricted the stranger has no vault to do it with.
    function test_creation_restricted_closesTheUseUpOfTheTotalCap() public {
        _caps(CAP, CAP);
        uint256 open = vm.snapshotState();
        BasketVault griefer = _createVault(stranger, keccak256("grief"));
        cash.mint(stranger, CAP);
        vm.startPrank(stranger);
        cash.approve(address(griefer), CAP);
        griefer.deposit(CAP);
        griefer.ownerSwap(_swaps(_swap(direct, address(cash), address(stockA), CAP, 100 * unit)), LATER);
        griefer.withdraw(address(stockA), 100 * unit);
        vm.stopPrank();
        address[] memory list = new address[](1);
        list[0] = address(griefer);
        factory.syncDeposits(list);
        assertEq(factory.totalDeposited(), CAP, "an empty vault, still counted: a recount cannot lower it");
        _expectDepositRevert(vault, 1, abi.encodeWithSelector(IVaultConfig.TotalCapReached.selector, CAP + 1, CAP));

        vm.revertToState(open);
        vm.startPrank(admin);
        factory.setCreator(owner, true);
        factory.setCreationRestricted(true);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAllowedToCreate.selector, stranger));
        vm.prank(stranger);
        factory.createVault(keccak256("grief"), new Weight[](0), bytes32(0), 0, false);
        _deposit(vault, CAP);
    }

    // ---- a factory and a vault that came from the layout before

    /// What an upgrade of a live factory and its vaults reads in the new fields is zero, and zero is no
    /// cap: deposits stay open and unlimited after an upgrade, with nothing for the admin to set first. A
    /// vault that already holds cash has no count and no remembered cash token, and counts from its next
    /// deposit on; its way out is as before. A cap set later bites from then.
    function test_upgrade_fromTheLayoutBefore_staysOpenAndUncapped_untilACapIsSet() public {
        _deposit(vault, 3000 * USD);
        uint256 c =
            uint256(keccak256(abi.encode(uint256(keccak256("basket.storage.VaultConfig")) - 1))) & ~uint256(0xff);
        uint256 v =
            uint256(keccak256(abi.encode(uint256(keccak256("basket.storage.BasketVault")) - 1))) & ~uint256(0xff);
        for (uint256 i = 15; i <= 17; ++i) {
            vm.store(address(factory), bytes32(c + i), bytes32(0));
        }
        vm.store(address(factory), keccak256(abi.encode(address(vault), c + 18)), bytes32(0));
        vm.store(address(vault), bytes32(v + 11), bytes32(0));
        vm.store(address(vault), bytes32(v + 12), bytes32(0));
        (uint256 perVault, uint256 total) = factory.depositCaps();
        assertEq(perVault, 0);
        assertEq(total, 0);
        assertEq(vault.netDeposited(), 0);

        assertFalse(factory.depositsPaused());
        assertFalse(factory.creationRestricted());

        vm.prank(owner);
        vault.withdraw(address(cash), 1000 * USD);
        assertEq(vault.netDeposited(), 0);
        // Open and unlimited, with no call from the admin.
        _deposit(vault, 500_000 * USD);
        assertEq(vault.netDeposited(), 500_000 * USD, "counted from the upgrade on");
        assertEq(factory.totalDeposited(), 500_000 * USD);
        _deposit(other, 1);

        // A cap set later holds from then: this vault is already over it.
        _caps(CAP, CAP);
        _expectDepositRevert(
            vault,
            1,
            abi.encodeWithSelector(IVaultConfig.VaultCapReached.selector, address(vault), 500_000 * USD + 1, CAP)
        );
        vm.prank(owner);
        vault.withdrawAll();
        assertEq(cash.balanceOf(address(vault)), 0);
    }

    // ---- fuzz: the arithmetic of the count

    /// Any run of deposits and cash withdrawals in one vault: the count is the running sum held at zero from
    /// below, it never passes the cap, and a deposit is refused exactly when it would.
    function testFuzz_count_followsDepositsAndCashWithdrawals(uint256 seed, uint96 capSeed) public {
        uint256 cap = bound(capSeed, 1, 1_000_000 * USD);
        _caps(cap, cap);
        uint256 model;
        for (uint256 i; i < 24; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 amount = bound(seed >> 8, 0, cap + cap / 2);
            if (seed & 1 == 0) {
                cash.mint(owner, amount);
                if (model + amount > cap) {
                    _expectDepositRevert(
                        vault,
                        amount,
                        abi.encodeWithSelector(
                            IVaultConfig.VaultCapReached.selector, address(vault), model + amount, cap
                        )
                    );
                } else {
                    _deposit(vault, amount);
                    model += amount;
                    assertEq(factory.depositedOf(address(vault)), model);
                }
            } else {
                amount = bound(amount, 0, cash.balanceOf(address(vault)));
                vm.prank(owner);
                vault.withdraw(address(cash), amount);
                model = model > amount ? model - amount : 0;
            }
            assertEq(vault.netDeposited(), model);
            assertLe(vault.netDeposited(), cap);
            assertLe(factory.totalDeposited(), cap);
        }
    }

    /// Two vaults under one total: whatever the split, the total counted never passes the cap, and after a
    /// sync it is exactly the sum of what the two vaults count.
    function testFuzz_totalCap_acrossTwoVaults(uint96 a, uint96 b, uint96 out, uint96 again) public {
        _caps(CAP, CAP);
        uint256 first = bound(a, 0, CAP);
        uint256 secondAmount = bound(b, 0, CAP);
        _deposit(vault, first);
        if (first + secondAmount > CAP) {
            _expectDepositRevert(
                other,
                secondAmount,
                abi.encodeWithSelector(IVaultConfig.TotalCapReached.selector, first + secondAmount, CAP)
            );
            secondAmount = 0;
        } else {
            _deposit(other, secondAmount);
        }
        uint256 taken = bound(out, 0, first);
        vm.prank(owner);
        vault.withdraw(address(cash), taken);

        address[] memory list = new address[](2);
        list[0] = address(vault);
        list[1] = address(other);
        factory.syncDeposits(list);
        assertEq(factory.totalDeposited(), first - taken + secondAmount);
        assertEq(factory.totalDeposited(), vault.netDeposited() + other.netDeposited());

        uint256 more = bound(again, 0, 2 * CAP);
        if (first - taken + secondAmount + more > CAP) {
            vm.expectRevert();
            vm.prank(second);
            other.deposit(more);
        } else {
            _deposit(other, more);
        }
        assertLe(factory.totalDeposited(), CAP);
    }
}
