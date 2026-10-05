// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {IBasketVault} from "../src/interfaces/IBasketVault.sol";
import {AssetConfig, Params, Snapshot, Swap, Weight} from "../src/interfaces/Types.sol";
import {KeeperFixture} from "./helpers/KeeperFixture.sol";
import {MockFeed} from "./mocks/Feeds.sol";
import {MockRouter} from "./mocks/Routers.sol";

/// The keeper's trade, check by check (DESIGN-VAULT.md section 5), and the hostile cases of section 13 that
/// apply to it. Each check has a test at its boundary that fails when the check is taken out
/// (`script/rules-bite.mjs`). Every test runs with the stock tokens at 6, 8 and 18 decimals; cash has 6.
abstract contract KeeperSwapTest is KeeperFixture {
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        _deployKeeperPlatform();
    }

    // ---- helpers

    /// The owner buys `cashAmount` of `token` at the feed's price, as the person would.
    function _ownerBuys(address token, uint256 cashAmount) internal {
        Swap memory s = _swap(direct, address(cash), token, cashAmount, _amountFor(token, cashAmount));
        vm.prank(owner);
        vault.ownerSwap(_swaps(s), LATER);
    }

    function _setAsset(address token, AssetConfig memory a) internal {
        vm.prank(admin);
        factory.setAsset(token, a);
    }

    function _setParams(Params memory p) internal {
        vm.prank(admin);
        factory.setParams(p);
    }

    /// Moves the clock by `seconds_` and writes the feeds again at the new time.
    function _later(uint256 seconds_) internal {
        vm.warp(block.timestamp + seconds_);
        _refresh();
    }

    function _lastKeeperAt(address token) internal view returns (uint64) {
        Snapshot memory snap = vault.snapshot();
        for (uint256 i; i < snap.tokens.length; ++i) {
            if (snap.tokens[i] == token) return snap.lastKeeperAt[i];
        }
        return 0;
    }

    // ---- an honest keeper

    function test_keeperSwap_buysTowardTheTarget() public {
        Swap memory s = _buy(direct, address(stockA), 4000 * USD, 0);
        vm.expectEmit(address(vault));
        emit IBasketVault.KeeperTrade(address(vault), address(cash), address(stockA), 4000 * USD, 40 * unit, 0, 0);
        (uint256 spent, uint256 received) = _keeperSwap(s);

        assertEq(spent, 4000 * USD);
        assertEq(received, 40 * unit);
        assertEq(stockA.balanceOf(address(vault)), 40 * unit);
        assertEq(cash.balanceOf(address(vault)), 6000 * USD);
        assertEq(_weightOf(address(stockA)), TARGET_A);
        assertEq(_lastKeeperAt(address(stockA)), block.timestamp);
        _assertNoAllowance(address(vault), address(cash), address(direct));
    }

    /// A11 on the keeper's path: through Permit2 nothing is left approved either.
    function test_A11_keeperSwap_throughPermit2_leavesNoAllowance() public {
        _keeperSwap(_buy(viaPermit2, address(stockA), 4000 * USD, 0));
        assertEq(stockA.balanceOf(address(vault)), 40 * unit);
        _assertNoAllowance(address(vault), address(cash), address(viaPermit2));
    }

    function test_keeperSwap_sellsBackTowardTheTarget() public {
        _ownerBuys(address(stockA), 6000 * USD);
        (uint256 spent, uint256 received) = _keeperSwap(_sell(direct, address(stockA), 20 * unit, 0));
        assertEq(spent, 20 * unit);
        assertEq(received, 2000 * USD);
        assertEq(_weightOf(address(stockA)), TARGET_A);
        _assertNoAllowance(address(vault), address(stockA), address(direct));
    }

    // ---- check 1: the keeper, and auto-follow

    /// A13: nobody but the config's keeper, the owner, the guardian and the admin included.
    function test_A13_aCallerOtherThanTheKeeper_isRefused() public {
        Swap memory s = _buy(direct, address(stockA), 4000 * USD, 0);
        address[4] memory callers = [stranger, owner, guardian, admin];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotKeeper.selector, callers[i]));
            vault.keeperSwap(s);
        }
        assertEq(stockA.balanceOf(address(vault)), 0);
    }

    function test_keeperSwap_followsTheKeeperTheConfigNames() public {
        address next = makeAddr("next-keeper");
        vm.prank(admin);
        factory.setKeeper(next);
        Swap memory s = _buy(direct, address(stockA), 4000 * USD, 0);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.NotKeeper.selector, keeper));
        vm.prank(next);
        vault.keeperSwap(s);
        assertEq(stockA.balanceOf(address(vault)), 40 * unit);
    }

    /// A13: auto-follow off, the keeper has nothing to do here.
    function test_A13_autoFollowOff_isRefused() public {
        vm.prank(owner);
        vault.setAutoFollow(false);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0), abi.encodeWithSelector(IBasketVault.AutoFollowOff.selector)
        );
    }

    // ---- check 11: the pause

    /// A8: paused, the keeper is refused and the owner withdraws and trades as before.
    function test_A8_paused_theKeeperIsRefused_andTheOwnerWithdraws() public {
        vm.prank(guardian);
        factory.pauseKeeper();
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0), abi.encodeWithSelector(IBasketVault.KeeperPaused.selector)
        );

        _ownerBuys(address(stockA), 1000 * USD);
        vm.startPrank(owner);
        vault.withdraw(address(stockA), 5 * unit);
        address[] memory skipped = vault.withdrawAll();
        vm.stopPrank();
        assertEq(skipped.length, 0);
        assertEq(cash.balanceOf(address(vault)), 0);
        assertEq(stockA.balanceOf(address(vault)), 0);
        assertEq(stockA.balanceOf(owner), 10 * unit);

        vm.prank(admin);
        factory.unpauseKeeper();
        vm.prank(owner);
        vault.deposit(START);
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 0));
    }

    // ---- check 2: cash on one side, a target on the other

    /// A4: a listed, priced asset the owner never chose.
    function test_A4_aTokenOutsideTheTargets_isRefused() public {
        _expectKeeperRevert(
            _buy(direct, address(stockC), 2000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.TokenNotAccepted.selector, address(stockC))
        );
    }

    function test_keeperSwap_twoAssets_isRefused() public {
        _ownerBuys(address(stockA), 6000 * USD);
        Swap memory s = _swap(direct, address(stockA), address(stockB), 10 * unit, 20 * unit);
        _expectKeeperRevert(
            s, abi.encodeWithSelector(IBasketVault.NotCashLeg.selector, address(stockA), address(stockB))
        );
    }

    function test_keeperSwap_cashForCash_isRefused() public {
        Swap memory s = _swap(direct, address(cash), address(cash), 100 * USD, 100 * USD);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.NotCashLeg.selector, address(cash), address(cash)));
    }

    /// An asset taken off the list stays a target: the keeper may sell it and may not buy it.
    function test_keeperSwap_aRemovedAsset_canBeSoldAndNotBought() public {
        _ownerBuys(address(stockA), 6000 * USD);
        vm.prank(admin);
        factory.removeAsset(address(stockA));
        // Under its target after the owner sells most of it: a purchase would be toward the target.
        Swap memory sale = _sell(direct, address(stockA), 50 * unit, 0);
        vm.prank(owner);
        vault.ownerSwap(_swaps(sale), LATER);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 1000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.TokenNotAccepted.selector, address(stockA))
        );
    }

    function test_keeperSwap_aRemovedAssetOverItsTarget_isSold() public {
        _ownerBuys(address(stockA), 6000 * USD);
        vm.prank(admin);
        factory.removeAsset(address(stockA));
        _keeperSwap(_sell(direct, address(stockA), 20 * unit, 0));
        assertEq(stockA.balanceOf(address(vault)), 40 * unit);
    }

    function test_keeperSwap_aRouterNotOnTheList_isRefused() public {
        MockRouter other = new MockRouter(false);
        Swap memory s = _buy(other, address(stockA), 4000 * USD, 0);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.RouterNotAllowed.selector, address(other)));
    }

    // ---- check 3: the vault's own balances

    /// A1: the output goes to the keeper. With the keeper's own minimum it fails on that; with no minimum,
    /// on the value the vault works out for itself.
    function test_A1_outputSentToTheKeeper_isRefused() public {
        Swap memory s = _buy(direct, address(stockA), 4000 * USD, 0);
        s.data = abi.encodeCall(MockRouter.swapTo, (address(cash), address(stockA), 4000 * USD, 40 * unit, keeper));
        _expectKeeperRevert(
            s, abi.encodeWithSelector(IBasketVault.ReceivedTooLittle.selector, address(stockA), 0, 40 * unit)
        );
        s.minOut = 0;
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.ValueTooLow.selector, 4000 * USD, 0));
        assertEq(stockA.balanceOf(keeper), 0);
        assertEq(cash.balanceOf(address(vault)), START);
    }

    /// A10: a router that takes another target of the vault through its back door.
    function test_A10_aRouterThatTakesAnotherTarget_isRefused() public {
        _ownerBuys(address(stockB), 1000 * USD);
        Swap memory s = _buy(direct, address(stockA), 4000 * USD, 0);
        s.data = abi.encodeCall(
            MockRouter.swapAndSeize, (address(cash), address(stockA), 4000 * USD, 40 * unit, address(stockB), 5 * unit)
        );
        _expectKeeperRevert(
            s, abi.encodeWithSelector(IBasketVault.OtherTokenDebited.selector, address(stockB), 20 * unit, 15 * unit)
        );
    }

    /// A10: a target sent in from outside counts at its price: on EVM the vault reads its balances, and a
    /// gift moves the weights at once (there is no `tracked` to sync). The keeper's trade then watches it.
    function test_A10_aTargetSentInFromOutside_isValuedAtItsPrice() public {
        stockB.mint(address(vault), 20 * unit);
        assertEq(vault.tokens().length, 1);
        // $11,000 now: 40% of it is $4,400.
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4500 * USD, 0),
            abi.encodeWithSelector(IBasketVault.PastTarget.selector, address(stockA))
        );
        _keeperSwap(_buy(direct, address(stockA), 4400 * USD, 0));
        assertEq(_weightOf(address(stockA)), TARGET_A);
        assertEq(vault.tokens().length, 3, "the gift is watched once a trade valued it");
    }

    /// A target whose balance cannot be read cannot be valued: the keeper stops for the vault. The owner's
    /// path does not read it.
    function test_keeperSwap_aTargetThatCannotBeRead_isRefused() public {
        vm.mockCallRevert(address(stockB), abi.encodeWithSignature("balanceOf(address)", address(vault)), "");
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.BalanceUnreadable.selector, address(stockB))
        );
        vm.prank(owner);
        vault.withdraw(address(cash), 1 * USD);
    }

    /// The traded asset and the cash must be readable too: they are what the trade is measured by.
    function test_keeperSwap_theAssetOrTheCashUnreadable_isRefused() public {
        address[2] memory traded = [address(stockA), address(cash)];
        for (uint256 i; i < traded.length; ++i) {
            vm.mockCallRevert(traded[i], abi.encodeWithSignature("balanceOf(address)", address(vault)), "");
            _expectKeeperRevert(
                _buy(direct, address(stockA), 4000 * USD, 0),
                abi.encodeWithSelector(IBasketVault.BalanceUnreadable.selector, traded[i])
            );
            vm.clearMockedCalls();
        }
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 0));
    }

    /// Permit2, the vault itself and a token it holds are never a router, whatever the config says: the
    /// vault checks again for itself.
    function test_hostile_permit2TheVaultOrATokenAsRouter_isRefusedTwice() public {
        address[3] memory reserved = [PERMIT2_ADDRESS, address(vault), address(cash)];
        for (uint256 i; i < reserved.length; ++i) {
            Swap memory s = Swap(reserved[i], address(cash), address(stockA), 4000 * USD, 0, "");
            _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.RouterNotAllowed.selector, reserved[i]));
            vm.mockCall(
                address(factory), abi.encodeWithSignature("routerPull(address)", reserved[i]), abi.encode(uint8(1))
            );
            _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.RouterNotAllowed.selector, reserved[i]));
            vm.clearMockedCalls();
        }
        assertEq(cash.balanceOf(address(vault)), START);
    }

    /// A17: a router that calls back into the vault mid-trade, into the keeper's trade or into adopt.
    function test_A17_reentryMidKeeperSwap_isRefused() public {
        bytes[2] memory inner = [
            abi.encodeCall(BasketVault.keeperSwap, (_buy(direct, address(stockB), 100 * USD, 0))),
            abi.encodeCall(BasketVault.adoptVersion, ())
        ];
        for (uint256 i; i < inner.length; ++i) {
            Swap memory s = _buy(direct, address(stockA), 4000 * USD, 0);
            s.data = abi.encodeCall(
                MockRouter.swapAndCall,
                (address(cash), address(stockA), 4000 * USD, 40 * unit, address(vault), inner[i])
            );
            _expectKeeperRevert(
                s,
                abi.encodeWithSelector(
                    IBasketVault.RouterFailed.selector,
                    address(direct),
                    abi.encodePacked(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
                )
            );
        }
    }

    /// A trade that spends nothing is refused, and does not use up the asset's cooldown.
    function test_keeperSwap_aRouteThatSpendsNothing_isRefused() public {
        Swap memory s = _swap(direct, address(cash), address(stockA), 4000 * USD, 0);
        s.data = abi.encodeCall(MockRouter.swap, (address(cash), address(stockA), 0, 0));
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.NothingTraded.selector));
        assertEq(_lastKeeperAt(address(stockA)), 0);
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 0));
    }

    // ---- check 4: the value received

    /// A2: one basis point worse than the tolerance is refused.
    function test_A2_aPriceWorseThanTheTolerance_isRefused() public {
        Swap memory s = _buy(direct, address(stockA), 4000 * USD, 126);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.ValueTooLow.selector, 4000 * USD, 3949_600_000));
    }

    function test_A2_atTheToleranceItself_passes() public {
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 125));
        assertEq(stockA.balanceOf(address(vault)), 395 * unit / 10);
    }

    function test_A2_aSaleWorseThanTheTolerance_isRefused() public {
        _ownerBuys(address(stockA), 6000 * USD);
        Swap memory s = _sell(direct, address(stockA), 20 * unit, 126);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.ValueTooLow.selector, 2000 * USD, 1974_800_000));
        _keeperSwap(_sell(direct, address(stockA), 20 * unit, 125));
    }

    // ---- check 5: toward the target, inside the band, no further, half as far

    /// A7: a purchase of an asset over its target, a sale of one under it, and either at the target.
    function test_A7_theWrongDirection_isRefused() public {
        _expectKeeperRevert(
            _sell(direct, address(stockA), 0, 0),
            abi.encodeWithSelector(IBasketVault.NotTowardTarget.selector, address(stockA))
        );
        _ownerBuys(address(stockA), 6000 * USD);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 100 * USD, 0),
            abi.encodeWithSelector(IBasketVault.NotTowardTarget.selector, address(stockA))
        );
    }

    function test_A7_atTheTarget_neitherWay() public {
        _ownerBuys(address(stockA), 4000 * USD);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 10 * USD, 0),
            abi.encodeWithSelector(IBasketVault.NotTowardTarget.selector, address(stockA))
        );
        _expectKeeperRevert(
            _sell(direct, address(stockA), unit / 10, 0),
            abi.encodeWithSelector(IBasketVault.NotTowardTarget.selector, address(stockA))
        );
    }

    /// A7: past the band on the far side. From nothing, 40.6% is refused and 40.5% is not.
    function test_A7_pastTheBand_isRefused() public {
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4060 * USD, 0),
            abi.encodeWithSelector(IBasketVault.PastTarget.selector, address(stockA))
        );
        _keeperSwap(_buy(direct, address(stockA), 4050 * USD, 0));
    }

    function test_A7_aSalePastTheBand_isRefused() public {
        _ownerBuys(address(stockA), 6000 * USD);
        _expectKeeperRevert(
            _sell(direct, address(stockA), 2060 * unit / 100, 0),
            abi.encodeWithSelector(IBasketVault.PastTarget.selector, address(stockA))
        );
        _keeperSwap(_sell(direct, address(stockA), 2050 * unit / 100, 0));
    }

    /// A trade that crosses the target ends at most half as far on the other side: from 39.6%, 40.2% is
    /// allowed and 40.21% is not, though both are inside the band.
    function test_check5_aCrossingEndsAtMostHalfAsFar() public {
        _ownerBuys(address(stockA), 3960 * USD);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 61 * USD, 0),
            abi.encodeWithSelector(IBasketVault.PastTarget.selector, address(stockA))
        );
        _keeperSwap(_buy(direct, address(stockA), 60 * USD, 0));
        assertEq(_weightOf(address(stockA)), 4020);
    }

    /// A3: back and forth across the target. Each crossing must close the distance by half, so a stolen key
    /// cannot bounce an asset between the edges of the band paying the tolerance each way.
    function test_A3_churn_eachCrossingClosesTheDistance() public {
        _keeperSwap(_buy(direct, address(stockA), 4020 * USD, 0));
        _later(3600);
        // 40.2% to 39.8% is as far on the other side: refused.
        _expectKeeperRevert(
            _sell(direct, address(stockA), 4 * unit / 10, 0),
            abi.encodeWithSelector(IBasketVault.PastTarget.selector, address(stockA))
        );
        // 40.2% to 39.9% is half as far: allowed.
        _keeperSwap(_sell(direct, address(stockA), 3 * unit / 10, 0));
        assertEq(_weightOf(address(stockA)), 3990);
        _later(3600);
        // 39.9% to 40.06% is more than half as far again: refused; 40.05% is not.
        _expectKeeperRevert(
            _buy(direct, address(stockA), 16 * USD, 0),
            abi.encodeWithSelector(IBasketVault.PastTarget.selector, address(stockA))
        );
        _keeperSwap(_buy(direct, address(stockA), 15 * USD, 0));
    }

    // ---- check 6: the cooldown

    function test_keeperSwap_oneTradePerAssetPerCooldown() public {
        _keeperSwap(_buy(direct, address(stockA), 2000 * USD, 0));
        uint64 until = uint64(block.timestamp + 3600);
        Swap memory again = _buy(direct, address(stockA), 1000 * USD, 0);
        _expectKeeperRevert(again, abi.encodeWithSelector(IBasketVault.Cooldown.selector, address(stockA), until));
        // Another asset is not held up.
        _keeperSwap(_buy(direct, address(stockB), 1000 * USD, 0));
        vm.warp(until - 1);
        _expectKeeperRevert(again, abi.encodeWithSelector(IBasketVault.Cooldown.selector, address(stockA), until));
        vm.warp(until);
        _keeperSwap(again);
        assertEq(_lastKeeperAt(address(stockA)), until);
    }

    // ---- check 7: the weekly loss cap

    /// Two trades that lose 1.2% each: at a cap of 50 bps the second is refused, and the cap is a share of
    /// what the vault was worth before the trade.
    function test_lossCap_aTradeThatWouldPassTheCap_isRefused() public {
        Params memory p = _keeperParams();
        p.lossCapBps = 50;
        _setParams(p);
        vm.expectEmit(address(vault));
        emit IBasketVault.KeeperTrade(
            address(vault), address(cash), address(stockA), 4000 * USD, 3952 * unit / 100, 48 * USD, 48
        );
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 120));
        _expectKeeperRevert(
            _buy(direct, address(stockB), 3000 * USD, 120),
            abi.encodeWithSelector(IBasketVault.LossCapReached.selector, 84 * USD, 9952 * USD * 50 / BPS)
        );
        // A smaller loss still fits.
        _keeperSwap(_buy(direct, address(stockB), 3000 * USD, 5));
    }

    /// The counter drains in a straight line over seven days from the last loss.
    function test_lossCap_theCounterDrainsOverSevenDays() public {
        Params memory p = _keeperParams();
        p.lossCapBps = 50;
        _setParams(p);
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 120));
        Swap memory next = _buy(direct, address(stockB), 3000 * USD, 120);
        // Friday 15:00, four days on: three sevenths of 48 is left, and 36 more is past 49.76.
        _later(4 days);
        _expectKeeperRevert(
            next,
            abi.encodeWithSelector(IBasketVault.LossCapReached.selector, 20_571_428 + 36 * USD, 9952 * USD * 50 / BPS)
        );
        // The Monday after, seven days on: nothing is left.
        _later(3 days);
        _keeperSwap(next);
        assertEq(vault.snapshot().lossUsedBps, 36 * BPS / 9916);
    }

    /// A trade that loses nothing is not held to the cap and leaves the counter as it was.
    function test_lossCap_aTradeThatLosesNothing_leavesTheCounter() public {
        Params memory p = _keeperParams();
        p.lossCapBps = 0;
        _setParams(p);
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 0));
        assertEq(vault.snapshot().lossUsedBps, 0);
        _expectKeeperRevert(
            _buy(direct, address(stockB), 3000 * USD, 1),
            abi.encodeWithSelector(IBasketVault.LossCapReached.selector, 300_000, 0)
        );
    }

    /// A trade that loses nothing does not start the seven days again.
    function test_lossCap_aTradeThatLosesNothing_doesNotRestartTheSevenDays() public {
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 120));
        _later(4 days);
        _keeperSwap(_buy(direct, address(stockB), 3000 * USD, 0));
        _later(3 days);
        assertEq(vault.snapshot().lossUsedBps, 0);
    }

    /// A loss starts the seven days again for all that is left on the counter.
    function test_lossCap_aLossRestartsTheSevenDays() public {
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 120));
        _later(4 days);
        _keeperSwap(_buy(direct, address(stockB), 3000 * USD, 120));
        // Seven days after the first loss, three after the second: the counter is not empty.
        _later(3 days);
        assertGt(vault.snapshot().lossUsedBps, 0);
        // Past seven days after the second loss, nothing is left.
        _later(5 days);
        assertEq(vault.snapshot().lossUsedBps, 0);
    }

    // ---- check 8: the price reference

    /// A5: older than the asset's `maxAge`.
    function test_A5_aStalePrice_isRefused() public {
        vm.warp(MONDAY_1500 + 26 hours + 1);
        averageA.set(int256(PRICE_A), block.timestamp);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.PriceStale.selector, address(stockA), MONDAY_1500)
        );
        vm.warp(MONDAY_1500 + 26 hours);
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 0));
    }

    function test_A5_aStaleAverage_isRefused() public {
        averageA.set(int256(PRICE_A), block.timestamp - 26 hours - 1);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.PriceStale.selector, address(stockA), block.timestamp - 26 hours - 1)
        );
    }

    /// A price stamped further ahead of the clock than its age allows was not stamped in unix seconds.
    function test_A5_aPriceStampedAhead_isRefused() public {
        feedA.set(int256(PRICE_A), block.timestamp + 26 hours + 1);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.PriceStale.selector, address(stockA), block.timestamp + 26 hours + 1)
        );
        feedA.set(int256(PRICE_A), block.timestamp + 26 hours);
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 0));
    }

    /// Every other target the vault holds is held to its reference too.
    function test_A5_anotherHeldTargetsStalePrice_isRefused() public {
        uint256 stale = block.timestamp - 26 hours - 1;
        // Holding none of B, its feed is not read.
        feedB.set(int256(PRICE_B), stale);
        _keeperSwap(_buy(direct, address(stockA), 2000 * USD, 0));
        // Holding some, it is.
        vm.prank(owner);
        vault.ownerSwap(_swaps(_swap(direct, address(cash), address(stockB), 1000 * USD, 20 * unit)), LATER);
        vm.warp(block.timestamp + 3600);
        Swap memory s = _buy(direct, address(stockA), 1000 * USD, 0);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.PriceStale.selector, address(stockB), stale));
        feedB.set(int256(PRICE_B), block.timestamp);
        _keeperSwap(s);
    }

    function test_keeperSwap_aPriceOutsideItsRange_isRefused() public {
        feedA.set(150e8 + 1, block.timestamp);
        averageA.set(150e8 + 1, block.timestamp);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.PriceOutOfRange.selector, address(stockA), 150e8 + 1)
        );
        feedA.set(75e8 - 1, block.timestamp);
        averageA.set(75e8 - 1, block.timestamp);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.PriceOutOfRange.selector, address(stockA), 75e8 - 1)
        );
        feedA.set(75e8, block.timestamp);
        averageA.set(75e8, block.timestamp);
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 0));
    }

    /// The price and its average at most 200 bps apart, measured on the average.
    function test_keeperSwap_aPriceFarFromItsAverage_isRefused() public {
        feedA.set(102e8 + 1, block.timestamp);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.PriceDeviation.selector, address(stockA), 102e8 + 1, PRICE_A)
        );
        feedA.set(98e8 - 1, block.timestamp);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.PriceDeviation.selector, address(stockA), 98e8 - 1, PRICE_A)
        );
        feedA.set(102e8, block.timestamp);
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 0));
    }

    function test_keeperSwap_theSwitchOff_isRefused() public {
        AssetConfig memory a = factory.asset(address(stockA));
        a.flags = 0;
        _setAsset(address(stockA), a);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.KeeperAssetOff.selector, address(stockA))
        );
    }

    /// No price source, a feed that reverts, answers short, zero or below, and an average that does not
    /// answer: nothing to value at.
    function test_keeperSwap_noPrice_isRefused() public {
        Swap memory s = _buy(direct, address(stockA), 4000 * USD, 0);
        bytes memory err = abi.encodeWithSelector(IBasketVault.AssetNotPriced.selector, address(stockA));

        AssetConfig memory a = factory.asset(address(stockA));
        a.source = 0;
        a.flags = 0;
        _setAsset(address(stockA), a);
        _expectKeeperRevert(s, err);
        _setAsset(address(stockA), _keeperAsset(feedA, averageA, PRICE_A, 1));

        feedA.setBroken(true);
        _expectKeeperRevert(s, err);
        feedA.setBroken(false);
        feedA.setShort(true);
        _expectKeeperRevert(s, err);
        feedA.setShort(false);
        feedA.set(0, block.timestamp);
        _expectKeeperRevert(s, err);
        feedA.set(-1, block.timestamp);
        _expectKeeperRevert(s, err);
        feedA.set(int256(PRICE_A), block.timestamp);
        averageA.setBroken(true);
        _expectKeeperRevert(s, err);
        averageA.setBroken(false);
        _keeperSwap(s);
    }

    /// On a chain with a sequencer feed: refused while it is down and for an hour after it comes back.
    function test_keeperSwap_theSequencerDown_isRefused() public {
        MockFeed sequencer = new MockFeed();
        vm.prank(admin);
        factory.setSequencerFeed(address(sequencer));
        Swap memory s = _buy(direct, address(stockA), 4000 * USD, 0);

        sequencer.set(1, block.timestamp);
        sequencer.setStartedAt(block.timestamp - 2 hours);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.SequencerDown.selector));
        sequencer.set(0, block.timestamp);
        sequencer.setStartedAt(block.timestamp - 1 hours + 1);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.SequencerDown.selector));
        sequencer.setBroken(true);
        sequencer.setStartedAt(block.timestamp - 1 hours);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.SequencerDown.selector));
        sequencer.setBroken(false);
        _keeperSwap(s);
    }

    // ---- check 9: the market

    /// A6: Saturday, with feeds written that minute.
    function test_A6_saturday_isRefused() public {
        _later(5 days);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.MarketClosed.selector, address(stockA))
        );
    }

    /// A6: one minute before the open, and at the close itself.
    function test_A6_beforeTheOpenAndAtTheClose_areRefused() public {
        uint256 midnight = MONDAY_1500 - 15 hours;
        Swap memory s = _buy(direct, address(stockA), 2000 * USD, 0);
        vm.warp(midnight + 52_200 - 60);
        _refresh();
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.MarketClosed.selector, address(stockA)));
        vm.warp(midnight + 52_200);
        _keeperSwap(s);
        vm.warp(midnight + 72_000);
        _refresh();
        Swap memory b = _buy(direct, address(stockB), 1000 * USD, 0);
        _expectKeeperRevert(b, abi.encodeWithSelector(IBasketVault.MarketClosed.selector, address(stockB)));
        vm.warp(midnight + 72_000 - 1);
        _keeperSwap(b);
    }

    /// A6b: a weekday holiday, with a feed under 26 hours old.
    function test_A6b_aWeekdayHoliday_isRefused() public {
        uint32 today = uint32(block.timestamp / 1 days);
        vm.prank(guardian);
        factory.addClosedDay(today);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.MarketClosed.selector, address(stockA))
        );
    }

    function test_keeperSwap_beforeClosedUntil_isRefused() public {
        uint64 until = uint64(block.timestamp + 1 hours);
        vm.prank(guardian);
        factory.extendClosedUntil(until);
        Swap memory s = _buy(direct, address(stockA), 4000 * USD, 0);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.MarketClosed.selector, address(stockA)));
        vm.warp(until);
        _keeperSwap(s);
    }

    /// An asset that trades at all hours is open on a Saturday and on a holiday.
    function test_keeperSwap_anAssetOfAllHours_tradesOnSaturday() public {
        vm.startPrank(owner);
        vault.setTargets(_targets(address(stockA), TARGET_A, address(stockC), 2000));
        vault.setAutoFollow(true);
        vm.stopPrank();
        _later(5 days);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.MarketClosed.selector, address(stockA))
        );
        _keeperSwap(_buy(direct, address(stockC), 2000 * USD, 0));
    }

    function test_keeperSwap_aHaltedAsset_isRefused() public {
        uint64 until = uint64(block.timestamp + 1 hours);
        vm.prank(guardian);
        factory.haltAsset(address(stockA), until);
        Swap memory s = _buy(direct, address(stockA), 4000 * USD, 0);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.AssetHalted.selector, address(stockA), until));
        _keeperSwap(_buy(direct, address(stockB), 1000 * USD, 0));
        vm.warp(until);
        _keeperSwap(s);
    }

    /// The issuer's pause, read through the probe the config names; a probe that does not answer refuses.
    function test_keeperSwap_aTokenItsIssuerPaused_isRefused() public {
        AssetConfig memory a = factory.asset(address(stockA));
        a.pauseProbe = address(stockA);
        a.pauseSelector = bytes4(keccak256("paused()"));
        _setAsset(address(stockA), a);
        Swap memory s = _buy(direct, address(stockA), 4000 * USD, 0);
        bytes memory err = abi.encodeWithSelector(IBasketVault.AssetPaused.selector, address(stockA));
        stockA.setPaused(true);
        _expectKeeperRevert(s, err);
        stockA.setPaused(false);
        stockA.setSilent(true);
        _expectKeeperRevert(s, err);
        stockA.setSilent(false);
        _keeperSwap(s);
    }

    // ---- check 10: the multiplier window

    /// A12: within a day of the token's multiplier change, before or after; a schedule that does not answer
    /// refuses too.
    function test_A12_insideTheMultiplierWindow_isRefused() public {
        AssetConfig memory a = factory.asset(address(stockA));
        a.scheduleSelector = bytes4(keccak256("effectiveAt()"));
        _setAsset(address(stockA), a);
        Swap memory s = _buy(direct, address(stockA), 4000 * USD, 0);

        stockA.setSchedule(block.timestamp + 1 days - 1);
        _expectKeeperRevert(
            s,
            abi.encodeWithSelector(
                IBasketVault.MultiplierWindow.selector, address(stockA), block.timestamp + 1 days - 1
            )
        );
        stockA.setSchedule(block.timestamp - 1 days + 1);
        _expectKeeperRevert(
            s,
            abi.encodeWithSelector(
                IBasketVault.MultiplierWindow.selector, address(stockA), block.timestamp - 1 days + 1
            )
        );
        stockA.setSilent(true);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.MultiplierWindow.selector, address(stockA), 0));
        stockA.setSilent(false);
        stockA.setSchedule(block.timestamp + 1 days);
        _keeperSwap(s);
    }

    // ---- the largest value measured

    function test_keeperSwap_aVaultPastTheLargestValue_isRefused() public {
        cash.mint(address(vault), 1e30);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.ValueTooLarge.selector, 1e30 + START)
        );
        stockB.mint(address(vault), 1e30 * unit);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD, 0),
            abi.encodeWithSelector(IBasketVault.ValueTooLarge.selector, 1e30 * PRICE_B / 1e8 * USD)
        );
    }

    // ---- a stolen keeper key, and the owner's path

    /// The keeper has one function. Everything that moves tokens to someone is the owner's.
    function test_hostile_aStolenKeeperKey_reachesNothingOfTheOwners() public {
        bytes[7] memory calls = [
            abi.encodeCall(BasketVault.withdraw, (address(cash), 1)),
            abi.encodeCall(BasketVault.withdrawAll, ()),
            abi.encodeCall(BasketVault.deposit, (1)),
            abi.encodeCall(BasketVault.ownerSwap, (_swaps(_buy(direct, address(stockA), 100 * USD, 0)), LATER)),
            abi.encodeCall(BasketVault.setTargets, (new Weight[](0))),
            abi.encodeCall(BasketVault.setAutoFollow, (false)),
            abi.encodeCall(BasketVault.acceptVersion, (bytes32(uint256(1)), 1))
        ];
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(keeper);
            (bool ok, bytes memory ret) = address(vault).call(calls[i]);
            assertFalse(ok);
            assertEq(ret, abi.encodeWithSelector(IBasketVault.NotOwner.selector, keeper));
        }
        assertEq(cash.balanceOf(address(vault)), START);
    }

    /// I4 and A8: nothing the keeper's path reads is read by the owner's. With the keeper paused, every
    /// asset halted, the market closed, every feed dead and every switch off, the owner deposits, trades,
    /// sets targets, switches auto-follow and withdraws everything.
    function test_I4_theOwnersPath_withEveryKeeperSwitchAgainstIt() public {
        vm.startPrank(guardian);
        factory.pauseKeeper();
        factory.haltAsset(address(stockA), type(uint64).max);
        factory.haltAsset(address(stockB), type(uint64).max);
        factory.extendClosedUntil(type(uint64).max);
        vm.stopPrank();
        MockFeed sequencer = new MockFeed();
        sequencer.set(1, block.timestamp);
        vm.startPrank(admin);
        factory.setSequencerFeed(address(sequencer));
        AssetConfig memory a = factory.asset(address(stockA));
        a.flags = 0;
        factory.setAsset(address(stockA), a);
        vm.stopPrank();
        feedA.setBroken(true);
        feedB.setBroken(true);
        averageA.setBroken(true);
        vm.warp(block.timestamp + 5 days);

        vm.startPrank(owner);
        vault.deposit(1000 * USD);
        vault.ownerSwap(_swaps(_swap(direct, address(cash), address(stockA), 1000 * USD, 10 * unit)), LATER);
        vault.setTargets(_targets(address(stockA), 5000, address(stockB), 1000));
        vault.setAutoFollow(true);
        vault.withdraw(address(stockA), unit);
        address[] memory skipped = vault.withdrawAll();
        vm.stopPrank();
        assertEq(skipped.length, 0);
        assertEq(cash.balanceOf(address(vault)), 0);
        assertEq(stockA.balanceOf(address(vault)), 0);
    }

    // ---- the read the app makes

    function test_snapshot_readsTheVault() public {
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 120));
        Snapshot memory snap = vault.snapshot();
        assertEq(snap.owner, owner);
        assertEq(snap.planId, PLAN_ID);
        assertTrue(snap.autoFollow);
        assertEq(snap.operator, address(0));
        assertEq(snap.tokens.length, 3);
        Weight[] memory targets = vault.targets();
        for (uint256 i; i < 2; ++i) {
            assertEq(snap.tokens[i], targets[i].token);
            assertEq(snap.targetBps[i], targets[i].bps);
            uint256 price = snap.tokens[i] == address(stockA) ? 100e18 : 50e18;
            assertEq(snap.prices[i], price);
            assertEq(snap.priceUpdatedAt[i], MONDAY_1500);
        }
        assertEq(snap.tokens[2], address(cash));
        assertEq(snap.targetBps[2], 3000);
        assertEq(snap.balances[2], 6000 * USD);
        assertEq(snap.prices[2], 1e18);
        assertEq(snap.lossUsedBps, 48 * BPS / 9952);
        assertEq(_lastKeeperAt(address(stockA)), block.timestamp);
        assertEq(_lastKeeperAt(address(stockB)), 0);
        // A dead feed reads as no price, and the view does not revert.
        feedB.setBroken(true);
        snap = vault.snapshot();
        for (uint256 i; i < 2; ++i) {
            if (snap.tokens[i] == address(stockB)) assertEq(snap.prices[i], 0);
        }
    }
}

contract KeeperSwap6Test is KeeperSwapTest {
    function _decimals() internal pure override returns (uint8) {
        return 6;
    }
}

contract KeeperSwap8Test is KeeperSwapTest {
    function _decimals() internal pure override returns (uint8) {
        return 8;
    }
}

contract KeeperSwap18Test is KeeperSwapTest {
    function _decimals() internal pure override returns (uint8) {
        return 18;
    }
}
