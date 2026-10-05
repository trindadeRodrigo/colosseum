// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {IBasketVault} from "../../src/interfaces/IBasketVault.sol";
import {AssetConfig, Params, Swap, Weight} from "../../src/interfaces/Types.sol";
import {StubSequencerFeed} from "../../src/testnet/StubSequencerFeed.sol";
import {TestPriceFeed} from "../../src/testnet/TestPriceFeed.sol";
import {TestStockToken} from "../../src/testnet/TestStockToken.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";
import {MockRouter} from "../mocks/Routers.sol";

/// The vault, unchanged, against the test network's own contracts (TNET-1) in place of the real ones: test
/// cash at 6 decimals, two test stock tokens at 18 with Robinhood's multiplier and pause calls, a price
/// contract and an average contract per stock, and the sequencer stub. Every keeper check that reads one of
/// them runs here against the real call, as `test/KeeperSwap.t.sol` runs it against the mocks: the feed and
/// its average, their age, their distance, the range, the issuer's pause, the multiplier window and the
/// sequencer. The router is the mock exchange of the unit tests; TNET-2's fork run takes Universal Router.
///
/// The clock starts on Monday 2026-10-05 at 15:00 UTC, inside the session.
contract TestnetVaultTest is VaultFixture {
    uint256 internal constant MONDAY_1500 = 1_791_212_400;
    uint256 internal constant USD = 1e6;
    uint256 internal constant UNIT = 1e18;
    uint256 internal constant START = 10_000 * USD;
    uint256 internal constant PRICE_A = 700e8;
    uint256 internal constant PRICE_B = 180e8;
    bytes4 internal constant PAUSED = bytes4(keccak256("paused()"));
    bytes4 internal constant EFFECTIVE_AT = bytes4(keccak256("effectiveAt()"));

    address internal issuer = makeAddr("issuer");
    address internal writer = makeAddr("writer");

    TestToken internal cash;
    TestStockToken internal stockA;
    TestStockToken internal stockB;
    TestPriceFeed internal feedA;
    TestPriceFeed internal averageA;
    TestPriceFeed internal feedB;
    TestPriceFeed internal averageB;
    MockRouter internal direct;
    MockRouter internal viaPermit2;

    function setUp() public {
        _deployPlatform();
        vm.warp(MONDAY_1500);
        cash = new TestToken("Test USDG", "tUSDG", 6, admin);
        stockA = new TestStockToken("Test SPY", "tSPY", 18, admin);
        stockB = new TestStockToken("Test NVDA", "tNVDA", 18, admin);
        vm.startPrank(admin);
        cash.grantRole(cash.MINTER_ROLE(), admin);
        stockA.grantRole(stockA.MINTER_ROLE(), admin);
        stockB.grantRole(stockB.MINTER_ROLE(), admin);
        stockA.grantRole(stockA.ISSUER_ROLE(), issuer);
        stockB.grantRole(stockB.ISSUER_ROLE(), issuer);
        vm.stopPrank();

        (feedA, averageA) = _priced(stockA, PRICE_A, "tSPY");
        (feedB, averageB) = _priced(stockB, PRICE_B, "tNVDA");
        vm.startPrank(admin);
        factory.setAsset(address(cash), _assetConfig(6));
        factory.setCashToken(address(cash));
        factory.setParams(
            Params({
                toleranceBps: 125,
                lossCapBps: 100,
                bandBps: 50,
                assetCooldown: 3600,
                sessionOpen: 52_200,
                sessionClose: 72_000
            })
        );
        factory.setPriceDevBps(200);
        direct = new MockRouter(false);
        viaPermit2 = new MockRouter(true);
        factory.setRouter(address(direct), 1);
        factory.setRouter(address(viaPermit2), 2);
        MockRouter[2] memory routers = [direct, viaPermit2];
        for (uint256 i; i < routers.length; ++i) {
            cash.mint(address(routers[i]), 1e9 * USD);
            stockA.mint(address(routers[i]), 1e6 * UNIT);
            stockB.mint(address(routers[i]), 1e6 * UNIT);
        }
        cash.mint(owner, 1_000_000 * USD);
        vm.stopPrank();

        vm.startPrank(owner);
        cash.approve(address(vault), type(uint256).max);
        vault.deposit(START);
        Weight[] memory targets = new Weight[](2);
        (targets[0], targets[1]) = address(stockA) < address(stockB)
            ? (Weight(address(stockA), 4000), Weight(address(stockB), 3000))
            : (Weight(address(stockB), 3000), Weight(address(stockA), 4000));
        vault.setTargets(targets);
        vault.setAutoFollow(true);
        vm.stopPrank();
    }

    /// Lists `token` as the test network's config does: its price and its average, each a test price
    /// contract written now at `price`, a range from three quarters of the price to one and a half times
    /// it, the issuer's pause and the multiplier's schedule read on the token, a US stock, the keeper's
    /// switch on.
    function _priced(TestStockToken token, uint256 price, string memory symbol)
        internal
        returns (TestPriceFeed feed_, TestPriceFeed average)
    {
        feed_ = new TestPriceFeed(8, string.concat(symbol, " / USD (test network)"), admin, writer);
        average = new TestPriceFeed(8, string.concat(symbol, " / USD one-hour average (test network)"), admin, writer);
        vm.startPrank(writer);
        feed_.write(int256(price), block.timestamp);
        average.write(int256(price), block.timestamp);
        vm.stopPrank();
        vm.prank(admin);
        factory.setAsset(
            address(token),
            AssetConfig({
                feed: address(feed_),
                tokenDecimals: 18,
                feedDecimals: 8,
                maxAge: 26 hours,
                session: 1,
                source: 1,
                maxWeightBps: 5000,
                pauseProbe: address(token),
                pauseSelector: PAUSED,
                scheduleSelector: EFFECTIVE_AT,
                haltUntil: 0,
                flags: 1,
                averageFeed: address(average),
                minPrice: uint128(price * 3 / 4),
                maxPrice: uint128(price * 3 / 2)
            })
        );
    }

    /// Moves the clock by `seconds_` and writes every price and average again, unchanged, at the new time.
    function _later(uint256 seconds_) internal {
        vm.warp(block.timestamp + seconds_);
        TestPriceFeed[4] memory feeds = [feedA, averageA, feedB, averageB];
        vm.startPrank(writer);
        for (uint256 i; i < feeds.length; ++i) {
            (, int256 answer,,,) = feeds[i].latestRoundData();
            feeds[i].write(answer, block.timestamp);
        }
        vm.stopPrank();
    }

    function _priceOf(address token) internal view returns (uint256) {
        (, int256 answer,,,) = (token == address(stockA) ? feedA : feedB).latestRoundData();
        return uint256(answer);
    }

    /// A buy of `token` for `cashAmount` through `router` at the feed's price.
    function _buy(MockRouter router, address token, uint256 cashAmount) internal view returns (Swap memory) {
        uint256 out = cashAmount * 1e8 * UNIT / (_priceOf(token) * USD);
        return Swap({
            router: address(router),
            tokenIn: address(cash),
            tokenOut: token,
            amountIn: cashAmount,
            minOut: out,
            data: abi.encodeCall(MockRouter.swap, (address(cash), token, cashAmount, out))
        });
    }

    function _keeperSwap(Swap memory s) internal returns (uint256 spent, uint256 received) {
        vm.prank(keeper);
        return vault.keeperSwap(s);
    }

    function _expectKeeperRevert(Swap memory s, bytes memory err) internal {
        vm.prank(keeper);
        vm.expectRevert(err);
        vault.keeperSwap(s);
    }

    // ---- the keeper's path, read from the test contracts

    function test_keeper_buysTowardTheTarget_atTheTestPrice() public {
        (uint256 spent, uint256 received) = _keeperSwap(_buy(direct, address(stockA), 4000 * USD));
        assertEq(spent, 4000 * USD);
        assertEq(received, 4000 * UNIT / 700);
        assertEq(stockA.balanceOf(address(vault)), received);
        assertEq(cash.balanceOf(address(vault)), START - spent);
    }

    /// Through a router that pulls with Permit2, as Universal Router does: nothing is left approved.
    function test_keeper_throughPermit2_leavesNoAllowance() public {
        _keeperSwap(_buy(viaPermit2, address(stockB), 3000 * USD));
        assertEq(stockB.balanceOf(address(vault)), 3000 * UNIT / 180);
        assertEq(cash.allowance(address(vault), PERMIT2_ADDRESS), 0);
        (bool ok, bytes memory ret) = PERMIT2_ADDRESS.staticcall(
            abi.encodeWithSignature("allowance(address,address,address)", address(vault), cash, viaPermit2)
        );
        assertTrue(ok);
        (uint160 amount,,) = abi.decode(ret, (uint160, uint48, uint48));
        assertEq(amount, 0);
    }

    /// The vault values every held target at its test price: a held stock B with no round newer than a day
    /// stops a purchase of A.
    function test_keeper_valuesEveryHeldTargetAtItsTestPrice() public {
        _keeperSwap(_buy(direct, address(stockB), 3000 * USD));
        vm.warp(block.timestamp + 26 hours + 1);
        vm.startPrank(writer);
        feedA.write(int256(PRICE_A), block.timestamp);
        averageA.write(int256(PRICE_A), block.timestamp);
        vm.stopPrank();
        (,,, uint256 bAt,) = feedB.latestRoundData();
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD),
            abi.encodeWithSelector(IBasketVault.PriceStale.selector, address(stockB), bAt)
        );
    }

    /// A price contract with no round yet: nothing to value at.
    function test_keeper_aFeedBeforeItsFirstRound_isNotAPrice() public {
        TestPriceFeed empty = new TestPriceFeed(8, "empty (test network)", admin, writer);
        AssetConfig memory a = factory.asset(address(stockA));
        a.feed = address(empty);
        vm.prank(admin);
        factory.setAsset(address(stockA), a);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD),
            abi.encodeWithSelector(IBasketVault.AssetNotPriced.selector, address(stockA))
        );
        a.feed = address(feedA);
        a.averageFeed = address(empty);
        vm.prank(admin);
        factory.setAsset(address(stockA), a);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD),
            abi.encodeWithSelector(IBasketVault.AssetNotPriced.selector, address(stockA))
        );
    }

    /// No round for longer than `maxAge`: the copier stopped, or the market closed for the weekend.
    function test_keeper_aStalePrice_isRefused() public {
        Swap memory s = _buy(direct, address(stockA), 4000 * USD);
        vm.warp(block.timestamp + 26 hours + 1);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.PriceStale.selector, address(stockA), MONDAY_1500));
    }

    /// A price written and its average not: the average's own time stops the trade.
    function test_keeper_aStaleAverage_isRefused() public {
        vm.warp(block.timestamp + 26 hours + 1);
        vm.prank(writer);
        feedA.write(int256(PRICE_A), block.timestamp);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD),
            abi.encodeWithSelector(IBasketVault.PriceStale.selector, address(stockA), MONDAY_1500)
        );
    }

    /// The copier wrote a price 3% from its average: further apart than 200 bps.
    function test_keeper_aPriceFarFromItsAverage_isRefused() public {
        uint256 moved = PRICE_A * 103 / 100;
        vm.warp(block.timestamp + 60);
        vm.prank(writer);
        feedA.write(int256(moved), block.timestamp);
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD),
            abi.encodeWithSelector(IBasketVault.PriceDeviation.selector, address(stockA), moved, PRICE_A)
        );
        vm.prank(writer);
        averageA.write(int256(moved), block.timestamp);
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD));
    }

    /// A price outside the range the admin set from the pool.
    function test_keeper_aPriceOutsideItsRange_isRefused() public {
        uint256 high = PRICE_A * 3 / 2 + 1;
        vm.warp(block.timestamp + 60);
        vm.startPrank(writer);
        feedA.write(int256(high), block.timestamp);
        averageA.write(int256(high), block.timestamp);
        vm.stopPrank();
        _expectKeeperRevert(
            _buy(direct, address(stockA), 4000 * USD),
            abi.encodeWithSelector(IBasketVault.PriceOutOfRange.selector, address(stockA), high)
        );
    }

    // ---- the token's own switches

    /// The issuer pauses the test token: the keeper is refused by the pause probe. The token cannot move, so
    /// the owner's `withdrawAll` skips it and pays the rest; unpaused, it comes out.
    function test_issuerPause_stopsTheKeeper_andTheOwnerTakesTheRest() public {
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD));
        uint256 heldA = stockA.balanceOf(address(vault));
        vm.prank(issuer);
        stockA.pause();
        vm.warp(block.timestamp + 1 hours);
        _later(0);
        // The probe is read on the asset traded only: B still trades while A, held, is paused.
        _keeperSwap(_buy(direct, address(stockB), 3000 * USD));
        Swap memory sellA = Swap({
            router: address(direct),
            tokenIn: address(stockA),
            tokenOut: address(cash),
            amountIn: 1,
            minOut: 0,
            data: abi.encodeCall(MockRouter.swap, (address(stockA), address(cash), 1, 0))
        });
        _expectKeeperRevert(sellA, abi.encodeWithSelector(IBasketVault.AssetPaused.selector, address(stockA)));

        vm.prank(owner);
        address[] memory skipped = vault.withdrawAll();
        assertEq(skipped.length, 1);
        assertEq(skipped[0], address(stockA));
        assertEq(cash.balanceOf(address(vault)), 0);
        assertEq(stockB.balanceOf(address(vault)), 0);
        assertEq(stockA.balanceOf(address(vault)), heldA);

        vm.prank(issuer);
        stockA.unpause();
        vm.prank(owner);
        vault.withdraw(address(stockA), heldA);
        assertEq(stockA.balanceOf(owner), heldA);
    }

    /// A multiplier change set for less than a day ahead, or one that took effect less than a day ago, keeps
    /// the keeper away from the token; a day either side, it trades.
    function test_multiplierWindow_aroundTheTestTokensChange() public {
        Swap memory s = _buy(direct, address(stockA), 4000 * USD);
        // The clock as a constant: under via-IR a read of `block.timestamp` kept in a local is not held
        // across `vm.warp`.
        uint256 ahead = MONDAY_1500 + 1 days - 1;
        vm.prank(issuer);
        stockA.updateMultiplier(1.01e18, ahead);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.MultiplierWindow.selector, address(stockA), ahead));

        vm.prank(issuer);
        stockA.updateMultiplier(1.01e18, MONDAY_1500);
        _expectKeeperRevert(
            s, abi.encodeWithSelector(IBasketVault.MultiplierWindow.selector, address(stockA), MONDAY_1500)
        );

        _later(1 days - 1);
        s = _buy(direct, address(stockA), 4000 * USD);
        _expectKeeperRevert(
            s, abi.encodeWithSelector(IBasketVault.MultiplierWindow.selector, address(stockA), MONDAY_1500)
        );
        _later(1);
        _keeperSwap(s);
        assertEq(stockA.uiMultiplier(), 1.01e18);
    }

    function test_multiplierWindow_aChangeADayAheadTrades() public {
        vm.prank(issuer);
        stockA.updateMultiplier(1.01e18, block.timestamp + 1 days);
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD));
    }

    // ---- the sequencer stub, on a chain whose config names one (Base)

    function test_sequencerStub_justUp_thenAnHourLater_thenDown() public {
        StubSequencerFeed seq = new StubSequencerFeed(admin, 0);
        vm.prank(admin);
        factory.setSequencerFeed(address(seq));
        Swap memory s = _buy(direct, address(stockA), 4000 * USD);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.SequencerDown.selector));

        _later(1 hours);
        s = _buy(direct, address(stockA), 2000 * USD);
        _keeperSwap(s);

        vm.prank(admin);
        seq.setDown(true);
        _later(2 hours);
        s = _buy(direct, address(stockB), 3000 * USD);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.SequencerDown.selector));
        vm.prank(admin);
        seq.setDown(false);
        _later(1 hours - 1);
        _expectKeeperRevert(s, abi.encodeWithSelector(IBasketVault.SequencerDown.selector));
        _later(1);
        _keeperSwap(s);
    }

    // ---- the owner's path reads none of it

    /// The owner trades and withdraws with every price stale and a multiplier change under way.
    function test_ownersPath_needsNoPriceAndNoWindow() public {
        vm.prank(issuer);
        stockA.updateMultiplier(1.01e18);
        vm.warp(block.timestamp + 30 days);
        Swap memory s = _buy(direct, address(stockA), 1000 * USD);
        vm.prank(owner);
        vault.ownerSwap(_swaps(s), LATER);
        assertGt(stockA.balanceOf(address(vault)), 0);
        vm.prank(owner);
        address[] memory skipped = vault.withdrawAll();
        assertEq(skipped.length, 0);
        assertEq(cash.balanceOf(address(vault)), 0);
        assertEq(stockA.balanceOf(address(vault)), 0);
    }

    /// The vault's read of itself prices each target from its test price contract.
    function test_snapshot_readsTheTestPrices() public {
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD));
        uint256 found;
        address[] memory tokens = vault.snapshot().tokens;
        uint256[] memory prices = vault.snapshot().prices;
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == address(stockA)) {
                assertEq(prices[i], 700e18);
                ++found;
            }
            if (tokens[i] == address(stockB)) {
                assertEq(prices[i], 180e18);
                ++found;
            }
        }
        assertEq(found, 2);
    }
}
