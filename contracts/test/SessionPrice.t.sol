// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {IBasketVault} from "../src/interfaces/IBasketVault.sol";
import {IVaultConfig} from "../src/interfaces/IVaultConfig.sol";
import {Swap} from "../src/interfaces/Types.sol";
import {KeeperFixture} from "./helpers/KeeperFixture.sol";

/// M1 of the review of 2026-10-09. A stock's `maxAge` is 26 hours, so that a feed which writes once a day
/// is not refused; but then, Tuesday to Friday, yesterday's close is "fresh" at the open and for as long as
/// the feed says nothing. With `sessionPriceAge` set, a keeper trade in session also needs the price of
/// every stock it values to be today's: stamped at or after the session's open, and no older than that age.
///
/// The clock: Monday 2026-10-05 15:00 UTC is the fixture's start; the session is 14:30 to 20:00 UTC.
contract SessionPriceTest is KeeperFixture {
    uint256 internal constant MIDNIGHT_MONDAY = MONDAY_1500 - 15 hours;
    uint256 internal constant OPEN = 52_200;
    uint256 internal constant CLOSE = 72_000;
    uint256 internal constant TUESDAY = MIDNIGHT_MONDAY + 1 days;
    uint256 internal constant SATURDAY = MIDNIGHT_MONDAY + 5 days;
    uint32 internal constant AGE = 1 hours;

    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function setUp() public {
        _deployKeeperPlatform();
    }

    function _rule(uint32 age) internal {
        vm.prank(admin);
        factory.setSessionPriceAge(age);
    }

    /// Stock A's price and average, stamped at `at`.
    function _stampA(uint256 at) internal {
        feedA.set(int256(PRICE_A), at);
        averageA.set(int256(PRICE_A), at);
    }

    function _buyA() internal view returns (Swap memory) {
        return _buy(direct, address(stockA), 2000 * USD, 0);
    }

    function _stale(uint256 stamp) internal view returns (bytes memory) {
        return abi.encodeWithSelector(IBasketVault.PriceStale.selector, address(stockA), stamp);
    }

    // ---- the setting

    function test_setSessionPriceAge_isTheAdminsOnly_andBounded() public {
        assertEq(factory.sessionPriceAge(), 0, "off until the admin sets it");
        address[3] memory others = [guardian, keeper, stranger];
        for (uint256 i; i < others.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, others[i]));
            vm.prank(others[i]);
            factory.setSessionPriceAge(AGE);
        }
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.ParamOutOfBounds.selector, bytes32("sessionPriceAge"), 59));
        factory.setSessionPriceAge(59);
        vm.expectRevert(
            abi.encodeWithSelector(IVaultConfig.ParamOutOfBounds.selector, bytes32("sessionPriceAge"), 26 hours + 1)
        );
        factory.setSessionPriceAge(26 hours + 1);
        vm.expectEmit(address(factory));
        emit IVaultConfig.SessionPriceAgeSet(26 hours);
        factory.setSessionPriceAge(26 hours);
        factory.setSessionPriceAge(60);
        factory.setSessionPriceAge(0);
        vm.stopPrank();
        assertEq(factory.sessionPriceAge(), 0);
    }

    // ---- the finding, and the fix

    /// As it was, and as it stays where the rule is off: at Tuesday's open, Monday's close passes.
    function test_M1_withTheRuleOff_yesterdaysCloseStillPassesAtTheOpen() public {
        _stampA(MIDNIGHT_MONDAY + CLOSE);
        vm.warp(TUESDAY + OPEN);
        _keeperSwap(_buyA());
    }

    function test_M1_yesterdaysClose_isRefusedAtTheOpen() public {
        _rule(AGE);
        uint256 close = MIDNIGHT_MONDAY + CLOSE;
        _stampA(close);
        vm.warp(TUESDAY + OPEN);
        _expectKeeperRevert(_buyA(), _stale(close));
    }

    function test_M1_yesterdaysClose_isRefusedMidSession() public {
        _rule(26 hours);
        uint256 close = MIDNIGHT_MONDAY + CLOSE;
        _stampA(close);
        // 19:00 on Tuesday: 23 hours old, inside any age up to 26 hours, and still not today's.
        vm.warp(TUESDAY + 19 hours);
        _expectKeeperRevert(_buyA(), _stale(close));
    }

    /// A round one second before today's open is yesterday's price for this purpose; one at the open is not.
    function test_M1_aRoundStampedBeforeTodaysOpen_isRefused_andOneAtTheOpenPasses() public {
        _rule(AGE);
        vm.warp(TUESDAY + OPEN + 10 minutes);
        _stampA(TUESDAY + OPEN - 1);
        _expectKeeperRevert(_buyA(), _stale(TUESDAY + OPEN - 1));
        _stampA(TUESDAY + OPEN);
        _keeperSwap(_buyA());
    }

    /// Today's, and older than the age: a feed that wrote at the open and then stalled.
    function test_M1_aPriceOfTodayOlderThanTheAge_isRefused() public {
        _rule(AGE);
        uint256 stamp = TUESDAY + OPEN + 5 minutes;
        _stampA(stamp);
        vm.warp(stamp + AGE + 1);
        _expectKeeperRevert(_buyA(), _stale(stamp));
        vm.warp(stamp + AGE);
        _keeperSwap(_buyA());
    }

    /// The average keeps the asset's own `maxAge`: only the price is held to today.
    function test_M1_theAverageKeepsTheAssetsOwnAge() public {
        _rule(AGE);
        vm.warp(TUESDAY + 16 hours);
        feedA.set(int256(PRICE_A), TUESDAY + 16 hours);
        averageA.set(int256(PRICE_A), TUESDAY + 16 hours - 25 hours);
        _keeperSwap(_buyA());
    }

    /// Every stock the trade values is held to it, not only the one traded.
    function test_M1_anotherHeldStocksOldPrice_refusesTheTrade() public {
        vm.prank(owner);
        vault.ownerSwap(_swaps(_swap(direct, address(cash), address(stockB), 1000 * USD, 20 * unit)), LATER);
        _rule(AGE);
        vm.warp(TUESDAY + 16 hours);
        _stampA(TUESDAY + 16 hours);
        uint256 close = MIDNIGHT_MONDAY + CLOSE;
        feedB.set(int256(PRICE_B), close);
        averageB.set(int256(PRICE_B), close);
        Swap memory s = _buyA();
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.PriceStale.selector, address(stockB), close));
        feedB.set(int256(PRICE_B), TUESDAY + 16 hours);
        _keeperSwap(s);
    }

    /// An asset that trades at all hours is not a stock: the rule does not touch it, in session or out.
    /// And outside the session a stock that is only held, not traded, is held to its `maxAge` as before:
    /// there is no session whose open its price could be after.
    function test_M1_appliesToStocksInSessionOnly() public {
        vm.startPrank(owner);
        vault.ownerSwap(_swaps(_swap(direct, address(cash), address(stockA), 1000 * USD, 10 * unit)), LATER);
        vault.setTargets(_targets(address(stockA), 1000, address(stockC), 4000));
        vault.setAutoFollow(true);
        vm.stopPrank();
        _rule(AGE);
        Swap memory buyC = _buy(direct, address(stockC), 1000 * USD, 0);

        // Friday's close for the stock, 20 hours old on Saturday at 16:00; the all-hours asset written at 03:00.
        uint256 fridayClose = MIDNIGHT_MONDAY + 4 days + CLOSE;
        uint256 saturdayNight = SATURDAY + 3 hours;
        _stampA(fridayClose);
        feedC.set(int256(PRICE_C), saturdayNight);
        averageC.set(int256(PRICE_C), saturdayNight);
        vm.warp(SATURDAY + 16 hours);
        _keeperSwap(buyC);

        // Tuesday in session: the same stock, held and not traded, must now have a price of the day.
        uint256 mondayClose = MIDNIGHT_MONDAY + 7 days + CLOSE;
        uint256 tuesdayInSession = MIDNIGHT_MONDAY + 8 days + 16 hours;
        _stampA(mondayClose);
        feedC.set(int256(PRICE_C), tuesdayInSession - 13 hours);
        averageC.set(int256(PRICE_C), tuesdayInSession - 13 hours);
        vm.warp(tuesdayInSession);
        _expectKeeperRevert(buyC, _stale(mondayClose));
        _stampA(tuesdayInSession);
        _keeperSwap(buyC);
    }

    // ---- the owner's path reads no price at all

    /// Nothing an owner does reads a feed: with the rule on and every price a week old, the owner deposits,
    /// trades and withdraws as before. Only `snapshot()`, a view that never reverts, shows a price.
    function test_M1_theOwnersPathReadsNoPrice() public {
        _rule(60);
        vm.warp(TUESDAY + 16 hours + 7 days);
        feedA.setBroken(true);
        averageB.setBroken(true);
        vm.startPrank(owner);
        vault.deposit(1000 * USD);
        vault.ownerSwap(_swaps(_swap(direct, address(cash), address(stockA), 1000 * USD, 10 * unit)), LATER);
        vault.ownerSwap(_swaps(_swap(direct, address(stockA), address(cash), 5 * unit, 500 * USD)), LATER);
        vault.withdraw(address(stockA), unit);
        assertEq(vault.snapshot().owner, owner);
        assertEq(vault.withdrawAll().length, 0);
        vm.stopPrank();
    }

    /// The session's own edges, by fuzz: a price is accepted exactly when it is of today's session and no
    /// older than the age.
    function testFuzz_M1_acceptedExactlyWhenOfTodayAndYoungEnough(uint32 nowSecond, uint32 back, uint32 ageSeed)
        public
    {
        uint256 age = bound(ageSeed, 60, 26 hours);
        _rule(uint32(age));
        uint256 clock = TUESDAY + bound(nowSecond, OPEN, CLOSE - 1);
        uint256 stamp = clock - bound(back, 0, 26 hours);
        _stampA(stamp);
        averageA.set(int256(PRICE_A), clock);
        vm.warp(clock);
        Swap memory s = _buyA();
        bool ok = stamp >= TUESDAY + OPEN && clock - stamp <= age;
        if (ok) _keeperSwap(s);
        else _expectKeeperRevert(s, _stale(stamp));
    }
}
