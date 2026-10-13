// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PoolAverageFeed} from "../src/price/PoolAverageFeed.sol";
import {MockRoundFeed} from "./mocks/Feeds.sol";
import {MockV3Pool} from "./mocks/Pools.sol";
import {MockToken} from "./mocks/Tokens.sol";

/// `PoolAverageFeed` on a mock pool and a mock Chainlink feed: the price it states for both token orders
/// and several decimals, which way it rounds, and every reason it gives no answer.
///
/// The asset is a stock of 18 decimals at about $230, the dollar token has 6, the feed 8: the shape of the
/// NVDA pool on Robinhood Chain, whose tick is near 221,937 with the dollar as token0.
contract PoolAverageFeedTest is Test {
    uint256 internal constant START = 1_791_212_400;
    uint32 internal constant WINDOW = 3600;
    uint128 internal constant LIQUIDITY = 7e18;
    uint128 internal constant FLOOR = 3.5e18;
    int24 internal constant TICK = 221_937;
    /// 1.0001^-221937 * 10^20, rounded down (`node script/tick-table.mjs --vectors`).
    uint256 internal constant PRICE = 23008084035;
    int256 internal constant SPOT = 230e8;

    MockToken internal stock;
    MockToken internal dollar;
    MockRoundFeed internal chainlink;
    /// The dollar is token0, as in the real NVDA pool.
    MockV3Pool internal pool;
    PoolAverageFeed internal feed;

    function setUp() public {
        vm.warp(START);
        stock = new MockToken(18);
        dollar = new MockToken(6);
        chainlink = new MockRoundFeed();
        chainlink.push(SPOT, START - 2 hours);
        pool = new MockV3Pool(address(dollar), address(stock), TICK, LIQUIDITY);
        feed = _feed(pool, stock, dollar);
        // An hour of history and a quiet Chainlink feed.
        vm.warp(START + WINDOW);
    }

    function _feed(MockV3Pool pool_, MockToken base, MockToken quote) internal returns (PoolAverageFeed) {
        return new PoolAverageFeed(
            address(pool_),
            address(base),
            address(quote),
            address(chainlink),
            base.decimals(),
            quote.decimals(),
            WINDOW,
            FLOOR,
            150,
            12
        );
    }

    function _reason(PoolAverageFeed f) internal view returns (PoolAverageFeed.Reason reason) {
        (,,,,, reason) = f.check();
    }

    function _average(PoolAverageFeed f) internal view returns (uint256 average) {
        (average,,,,,) = f.check();
    }

    function _assertRefuses(PoolAverageFeed f, PoolAverageFeed.Reason reason) internal {
        assertEq(uint8(_reason(f)), uint8(reason), "the reason");
        vm.expectRevert(abi.encodeWithSelector(PoolAverageFeed.NotPriced.selector, reason));
        f.latestRoundData();
    }

    function _assertAnswers(PoolAverageFeed f, uint256 price) internal view {
        assertEq(uint8(_reason(f)), uint8(PoolAverageFeed.Reason.None), "a reason where none was expected");
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            f.latestRoundData();
        assertEq(answer, int256(price));
        assertEq(roundId, 0);
        assertEq(answeredInRound, 0);
        assertEq(startedAt, block.timestamp);
        assertEq(updatedAt, block.timestamp);
    }

    // ---- the answer

    function test_answers_theAverageInTheFeedsShape() public view {
        _assertAnswers(feed, PRICE);
        assertEq(feed.decimals(), 8);
        assertEq(feed.description(), "TEST / USD (pool average)");
        assertEq(feed.version(), 1);
        (uint256 average, uint256 spot, uint256 own, uint128 liquidity, uint128 mean,) = feed.check();
        assertEq(average, PRICE);
        assertEq(spot, uint256(SPOT));
        assertEq(own, uint256(SPOT), "a round older than the window stood for all of it");
        assertEq(liquidity, LIQUIDITY);
        // The pool's sum of seconds over liquidity rounds down a second at a time.
        assertApproxEqRel(mean, LIQUIDITY, 1e6);
    }

    /// Nothing can be changed after deployment: what it was built with is what it reads.
    function test_everythingIsFixedAtDeployment() public view {
        assertEq(feed.pool(), address(pool));
        assertEq(feed.base(), address(stock));
        assertEq(feed.quote(), address(dollar));
        assertEq(feed.feed(), address(chainlink));
        assertEq(feed.window(), WINDOW);
        assertEq(feed.minLiquidity(), FLOOR);
        assertEq(feed.jumpBps(), 150);
        assertEq(feed.maxRounds(), 12);
        assertEq(feed.baseDecimals(), 18);
        assertEq(feed.quoteDecimals(), 6);
        assertFalse(feed.baseIsToken0());
    }

    /// The same market with the asset as token0: the pool's tick is the opposite, the answer the same.
    function test_answers_theSamePrice_whicheverTokenIsFirst() public {
        vm.warp(START);
        MockV3Pool flipped = new MockV3Pool(address(stock), address(dollar), -TICK, LIQUIDITY);
        PoolAverageFeed f = _feed(flipped, stock, dollar);
        assertTrue(f.baseIsToken0());
        vm.warp(START + WINDOW);
        _assertAnswers(f, PRICE);
    }

    /// Other decimals. A dollar of 18 and a stock of 6 need the raw price divided, not multiplied.
    function test_answers_acrossDecimals() public {
        vm.warp(START);
        MockToken six = new MockToken(6);
        MockToken eighteen = new MockToken(18);
        MockToken eight = new MockToken(8);
        MockToken alsoEight = new MockToken(8);
        // 1.0001^221937 * 10^(6 + 8 - 18).
        PoolAverageFeed divided = _feed(new MockV3Pool(address(six), address(eighteen), TICK, LIQUIDITY), six, eighteen);
        // 1.0001^-10 * 10^(8 + 8 - 8): two tokens of equal decimals, one tenth of a percent under par.
        PoolAverageFeed par =
            _feed(new MockV3Pool(address(eight), address(alsoEight), -10, LIQUIDITY), eight, alsoEight);
        vm.warp(START + WINDOW);
        _assertAnswers(divided, 434629);
        _assertAnswers(par, 99900054);
    }

    /// A feed of 18 decimals: the answer is in the feed's decimals, whatever they are.
    function test_answers_inTheFeedsOwnDecimals() public {
        vm.warp(START);
        chainlink.setDecimals(18);
        PoolAverageFeed f = _feed(new MockV3Pool(address(dollar), address(stock), TICK, LIQUIDITY), stock, dollar);
        vm.warp(START + WINDOW);
        assertEq(f.decimals(), 18);
        // 1.0001^-221937 * 10^30: the first eleven digits are the 8-decimal answer.
        assertEq(_average(f) / 1e10, PRICE);
    }

    /// The average is over time: 45 minutes at one tick and 15 at another is three parts to one.
    function test_average_weighsEachTickByTheTimeItStood() public {
        pool.moveTick(TICK - 400);
        vm.warp(block.timestamp + 15 minutes);
        uint256 got = _average(feed);
        assertGt(got, PRICE, "a lower tick of a pool with the dollar first is a dearer asset");
        // (45 * 221937 + 15 * 221537) / 60 is 221837 exactly: a pool that sat there for an hour.
        PoolAverageFeed there =
            _feed(new MockV3Pool(address(dollar), address(stock), TICK - 100, LIQUIDITY), stock, dollar);
        vm.warp(block.timestamp + WINDOW);
        assertEq(got, _average(there));
    }

    /// Rounding. An average tick between two ticks goes to the one that makes the asset cheaper, whichever
    /// token the asset is; then the price itself is rounded down. Half an hour at 100 and half at 101:
    function test_rounding_isDownInTheAssetsPrice_inBothOrders() public {
        vm.warp(START);
        MockToken a = new MockToken(18);
        MockToken b = new MockToken(6);
        // The asset first: its price is 1.0001^tick, and 100.5 goes to 100.
        MockV3Pool first = new MockV3Pool(address(a), address(b), 100, LIQUIDITY);
        // The asset second: its price is 1.0001^-tick, and -100.5 goes to -101.
        MockV3Pool second = new MockV3Pool(address(b), address(a), 100, LIQUIDITY);
        PoolAverageFeed f1 = _feed(first, a, b);
        PoolAverageFeed f2 = _feed(second, a, b);
        vm.warp(START + 30 minutes);
        first.moveTick(101);
        second.moveTick(101);
        vm.warp(START + WINDOW);
        // 1.0001^100 * 10^20 and 1.0001^-101 * 10^20, whole parts.
        assertEq(_average(f1), 101004966209287656885);
        assertEq(_average(f2), 98995133360784869684);
        // An average that is a whole tick is not rounded: a second pool that sat at 101 all hour.
        vm.warp(START + 30 minutes);
        MockV3Pool whole = new MockV3Pool(address(b), address(a), 101, LIQUIDITY);
        PoolAverageFeed f3 = _feed(whole, a, b);
        vm.warp(START + 30 minutes + WINDOW);
        assertEq(_average(f3), 98995133360784869684);
    }

    /// The pool's two counters are anywhere and wrap; only their difference is read.
    function test_average_acrossTheCountersWrapping() public {
        vm.warp(START);
        MockV3Pool wrapping = new MockV3Pool(address(dollar), address(stock), TICK, LIQUIDITY);
        // Close enough to the top of each that an hour of this pool passes it.
        wrapping.setCounters(type(int56).max - 1000, type(uint160).max - 1000);
        PoolAverageFeed f = _feed(wrapping, stock, dollar);
        vm.warp(START + WINDOW);
        _assertAnswers(f, PRICE);
        (,,,, uint128 mean,) = f.check();
        assertApproxEqRel(mean, LIQUIDITY, 1e6);
    }

    // ---- no answer: the pool

    function test_refuses_aThinPool() public {
        pool.move(TICK, FLOOR - 1);
        _assertRefuses(feed, PoolAverageFeed.Reason.ThinPool);
        // At the floor itself it answers: the hour's average is still what the pool held before.
        pool.move(TICK, FLOOR);
        assertEq(uint8(_reason(feed)), uint8(PoolAverageFeed.Reason.None));
    }

    /// Liquidity that is there now and was not for the hour: the average is what is held to the floor.
    function test_refuses_aPoolThatWasThinForTheHour() public {
        vm.warp(START);
        MockV3Pool thin = new MockV3Pool(address(dollar), address(stock), TICK, FLOOR / 10);
        PoolAverageFeed f = _feed(thin, stock, dollar);
        vm.warp(START + WINDOW);
        // Someone adds a great deal for this block.
        thin.move(TICK, LIQUIDITY * 100);
        (,,, uint128 now_, uint128 mean,) = f.check();
        assertEq(now_, LIQUIDITY * 100);
        assertLt(mean, FLOOR);
        _assertRefuses(f, PoolAverageFeed.Reason.ThinPool);
    }

    /// One second in the hour at a price where the pool holds nothing: the average liquidity falls to
    /// almost nothing, so a push past the last of the liquidity is told from a real price.
    function test_refuses_anHourWithOneSecondOfNoLiquidity() public {
        pool.move(TICK - 400_000, 0);
        vm.warp(block.timestamp + 1);
        pool.move(TICK, LIQUIDITY);
        vm.warp(block.timestamp + 10 minutes);
        (,,, uint128 now_, uint128 mean,) = feed.check();
        assertEq(now_, LIQUIDITY);
        assertLe(mean, WINDOW, "about one unit for every second of the window");
        _assertRefuses(feed, PoolAverageFeed.Reason.ThinPool);
        // Once that second is more than an hour old it is out of the average.
        vm.warp(block.timestamp + WINDOW);
        _assertAnswers(feed, PRICE);
    }

    function test_refuses_aPoolWithLessThanAnHourOfHistory() public {
        pool.restart();
        _assertRefuses(feed, PoolAverageFeed.Reason.ShortHistory);
        vm.warp(block.timestamp + WINDOW - 1);
        _assertRefuses(feed, PoolAverageFeed.Reason.ShortHistory);
        vm.warp(block.timestamp + 1);
        _assertAnswers(feed, PRICE);
    }

    function test_refuses_aPoolThatDoesNotAnswer() public {
        pool.setBroken(true);
        _assertRefuses(feed, PoolAverageFeed.Reason.ShortHistory);
        pool.setBroken(false);
        pool.setShort(true);
        _assertRefuses(feed, PoolAverageFeed.Reason.ShortHistory);
    }

    /// The pool names other tokens, or names them the other way round, or a token or the feed states
    /// other decimals than at deployment.
    function test_refuses_aPoolOrATokenThatChanged() public {
        pool.setTokens(address(stock), address(dollar));
        _assertRefuses(feed, PoolAverageFeed.Reason.PoolChanged);
        pool.setTokens(address(dollar), address(new MockToken(18)));
        _assertRefuses(feed, PoolAverageFeed.Reason.PoolChanged);
        pool.setTokens(address(dollar), address(stock));
        _assertAnswers(feed, PRICE);

        vm.mockCall(address(stock), abi.encodeWithSignature("decimals()"), abi.encode(uint8(8)));
        _assertRefuses(feed, PoolAverageFeed.Reason.PoolChanged);
        vm.clearMockedCalls();
        vm.mockCall(address(dollar), abi.encodeWithSignature("decimals()"), abi.encode(uint8(18)));
        _assertRefuses(feed, PoolAverageFeed.Reason.PoolChanged);
        vm.clearMockedCalls();
        chainlink.setDecimals(18);
        _assertRefuses(feed, PoolAverageFeed.Reason.PoolChanged);
        chainlink.setDecimals(8);
        vm.mockCallRevert(address(stock), abi.encodeWithSignature("decimals()"), "");
        _assertRefuses(feed, PoolAverageFeed.Reason.PoolChanged);
        vm.clearMockedCalls();
        _assertAnswers(feed, PRICE);
    }

    /// A tick past the ones the maths takes, either way.
    function test_refuses_aPriceItCannotState() public {
        vm.warp(START);
        MockV3Pool high = new MockV3Pool(address(dollar), address(stock), 443_637, LIQUIDITY);
        MockV3Pool low = new MockV3Pool(address(dollar), address(stock), -443_637, LIQUIDITY);
        MockV3Pool edge = new MockV3Pool(address(dollar), address(stock), -443_636, LIQUIDITY);
        PoolAverageFeed fHigh = _feed(high, stock, dollar);
        PoolAverageFeed fLow = _feed(low, stock, dollar);
        PoolAverageFeed fEdge = _feed(edge, stock, dollar);
        vm.warp(START + WINDOW);
        _assertRefuses(fHigh, PoolAverageFeed.Reason.PriceOutOfRange);
        _assertRefuses(fLow, PoolAverageFeed.Reason.PriceOutOfRange);
        // At the last tick: 1.0001^443636 * 10^20, which is 39 digits and over 128 bits.
        _assertRefuses(fEdge, PoolAverageFeed.Reason.PriceOutOfRange);
    }

    /// A price so small it rounds to nothing in the feed's decimals.
    function test_refuses_aPriceThatRoundsToZero() public {
        vm.warp(START);
        MockToken six = new MockToken(6);
        MockToken eighteen = new MockToken(18);
        // 1.0001^-400000 * 10^(6 + 8 - 18) is far under one unit.
        PoolAverageFeed f = _feed(new MockV3Pool(address(six), address(eighteen), -400_000, LIQUIDITY), six, eighteen);
        vm.warp(START + WINDOW);
        _assertRefuses(f, PoolAverageFeed.Reason.PriceOutOfRange);
    }

    // ---- no answer: Chainlink

    function test_refuses_aChainlinkFeedThatGivesNoPrice() public {
        chainlink.setBroken(true);
        _assertRefuses(feed, PoolAverageFeed.Reason.FeedDown);
        chainlink.setBroken(false);
        chainlink.push(0, block.timestamp);
        _assertRefuses(feed, PoolAverageFeed.Reason.FeedDown);
        chainlink.push(-1, block.timestamp);
        _assertRefuses(feed, PoolAverageFeed.Reason.FeedDown);
        chainlink.push(int256(uint256(type(uint128).max)) + 1, block.timestamp);
        _assertRefuses(feed, PoolAverageFeed.Reason.FeedDown);
        chainlink.push(SPOT, block.timestamp + 1);
        _assertRefuses(feed, PoolAverageFeed.Reason.FeedDown);
        chainlink.push(SPOT, 0);
        _assertRefuses(feed, PoolAverageFeed.Reason.FeedDown);
        // The pool's average is still shown.
        assertEq(_average(feed), PRICE);
    }

    /// A latest round older than the window stood for all of it: no earlier round is read.
    function test_aQuietFeed_readsNoEarlierRound() public {
        chainlink.setRoundsBroken(true);
        _assertAnswers(feed, PRICE);
        // One second inside the window, and the round before is needed.
        chainlink.setRoundsBroken(false);
        chainlink.push(SPOT, block.timestamp - WINDOW + 1);
        chainlink.setRoundsBroken(true);
        _assertRefuses(feed, PoolAverageFeed.Reason.FeedRounds);
        chainlink.setRoundsBroken(false);
        _assertAnswers(feed, PRICE);
    }

    /// A step of `bps` written `ago` seconds ago, after a quiet price. Each is a fresh run of rounds.
    function _stepped(uint256 bps, uint256 ago) internal returns (PoolAverageFeed.Reason) {
        chainlink.nextPhase();
        chainlink.push(SPOT, block.timestamp - 2 hours);
        chainlink.push(SPOT + SPOT * int256(bps) / 10_000, block.timestamp - ago);
        return _reason(feed);
    }

    /// Chainlink stepped inside the hour. The latest answer stood for `ago` seconds and the one before for
    /// the rest, so the average is `ago / 3600` of the way to the new price: a step of J is refused until
    /// `(1 - elapsed / 1h) * J` is inside the band.
    function test_refuses_aChainlinkStepOverTheBand() public {
        PoolAverageFeed.Reason jumped = PoolAverageFeed.Reason.FeedJumped;
        PoolAverageFeed.Reason none = PoolAverageFeed.Reason.None;
        // 5%: refused a minute after, twenty minutes after, and 41 minutes after; inside the band at 43.
        // (At 41 minutes the average is 3.42% up and the latest 5%: 153 bps apart on the average.)
        assertEq(uint8(_stepped(500, 1 minutes)), uint8(jumped));
        assertEq(uint8(_stepped(500, 20 minutes)), uint8(jumped));
        assertEq(uint8(_stepped(500, 41 minutes)), uint8(jumped));
        assertEq(uint8(_stepped(500, 43 minutes)), uint8(none));
        assertEq(uint8(_stepped(500, 59 minutes)), uint8(none));
        // 30%: refused until the step is nearly an hour old.
        assertEq(uint8(_stepped(3000, 30 minutes)), uint8(jumped));
        assertEq(uint8(_stepped(3000, 56 minutes)), uint8(jumped));
        assertEq(uint8(_stepped(3000, 57 minutes)), uint8(none));
        assertEq(uint8(_stepped(3000, 60 minutes)), uint8(none));
        // A step inside the band passes at once: the largest seen on mainnet was 109 bps.
        assertEq(uint8(_stepped(109, 1)), uint8(none));
        assertEq(uint8(_stepped(148, 1)), uint8(none));
        assertEq(uint8(_stepped(160, 1)), uint8(jumped));
        vm.expectRevert(abi.encodeWithSelector(PoolAverageFeed.NotPriced.selector, jumped));
        feed.latestRoundData();
    }

    /// The same downward.
    function test_refuses_aChainlinkStepDown() public {
        chainlink.push(SPOT * 95 / 100, block.timestamp - 1 minutes);
        _assertRefuses(feed, PoolAverageFeed.Reason.FeedJumped);
        (, uint256 spot, uint256 own,,,) = feed.check();
        assertEq(spot, uint256(SPOT * 95 / 100));
        // 59 minutes at 230 and one at 218.5.
        assertEq(own, (uint256(SPOT) * 59 + uint256(SPOT * 95 / 100)) / 60);
    }

    /// Several rounds inside the hour, each weighted by the time it stood.
    function test_ownAverage_overSeveralRounds() public {
        uint256 t = block.timestamp;
        chainlink.push(231e8, t - 50 minutes);
        chainlink.push(232e8, t - 30 minutes);
        chainlink.push(231e8, t - 10 minutes);
        (,, uint256 own,,, PoolAverageFeed.Reason reason) = feed.check();
        // 10 minutes at 230, 20 at 231, 20 at 232, 10 at 231.
        assertEq(own, (uint256(230e8) * 10 + uint256(231e8) * 20 + uint256(232e8) * 20 + uint256(231e8) * 10) / 60);
        assertEq(uint8(reason), uint8(PoolAverageFeed.Reason.None));
    }

    /// More rounds inside the hour than it reads: thirteen before the latest, against twelve.
    function test_refuses_moreRoundsThanItReads() public {
        uint256 t = block.timestamp;
        for (uint256 i = 13; i > 0; --i) {
            chainlink.push(SPOT, t - i * 4 minutes);
        }
        // Twelve before the latest reach back 52 minutes, and the thirteenth is needed.
        chainlink.push(SPOT, t);
        _assertRefuses(feed, PoolAverageFeed.Reason.FeedRounds);
        // Twelve minutes on, the twelfth before the latest is an hour old, and it is enough.
        vm.warp(t + 12 minutes);
        _assertAnswers(feed, PRICE);
    }

    function test_refuses_aMissingRound() public {
        uint256 t = block.timestamp;
        uint80 middle = chainlink.push(SPOT, t - 30 minutes);
        chainlink.push(SPOT, t - 10 minutes);
        _assertAnswers(feed, PRICE);
        chainlink.drop(middle);
        _assertRefuses(feed, PoolAverageFeed.Reason.FeedRounds);
    }

    /// Chainlink moved the feed to a new aggregator: the first round of the new one has none before it,
    /// so there is no answer until that round is an hour old.
    function test_refuses_aNewAggregator_forAnHour() public {
        chainlink.nextPhase();
        chainlink.push(SPOT, block.timestamp);
        _assertRefuses(feed, PoolAverageFeed.Reason.FeedRounds);
        vm.warp(block.timestamp + WINDOW - 1);
        _assertRefuses(feed, PoolAverageFeed.Reason.FeedRounds);
        vm.warp(block.timestamp + 1);
        _assertAnswers(feed, PRICE);
    }

    /// A round before the latest that is stamped after it, or that answers zero.
    function test_refuses_roundsOutOfOrderOrEmpty() public {
        uint256 t = block.timestamp;
        chainlink.push(SPOT, t - 5 minutes);
        chainlink.push(SPOT, t - 10 minutes);
        _assertRefuses(feed, PoolAverageFeed.Reason.FeedRounds);
        chainlink.push(0, t - 4 minutes);
        chainlink.push(SPOT, t - 3 minutes);
        _assertRefuses(feed, PoolAverageFeed.Reason.FeedRounds);
    }

    /// The reasons in the order the checks are made: the first that fails is the one told.
    function test_theFirstReasonIsTold() public {
        pool.move(TICK, 1);
        chainlink.push(SPOT * 2, block.timestamp);
        assertEq(uint8(_reason(feed)), uint8(PoolAverageFeed.Reason.ThinPool));
        chainlink.setBroken(true);
        assertEq(uint8(_reason(feed)), uint8(PoolAverageFeed.Reason.FeedDown));
        pool.setTokens(address(stock), address(dollar));
        assertEq(uint8(_reason(feed)), uint8(PoolAverageFeed.Reason.PoolChanged));
    }

    // ---- deployment

    function _new(
        address pool_,
        address base,
        address quote,
        address chainlink_,
        uint8 baseDecimals,
        uint8 quoteDecimals,
        uint32 window,
        uint128 floor,
        uint16 jump,
        uint8 rounds
    ) internal returns (PoolAverageFeed) {
        return new PoolAverageFeed(
            pool_, base, quote, chainlink_, baseDecimals, quoteDecimals, window, floor, jump, rounds
        );
    }

    function _expectSetup(string memory what) internal {
        vm.expectRevert(abi.encodeWithSelector(PoolAverageFeed.InvalidSetup.selector, what));
    }

    function test_deployment_refusesWhatCannotWork() public {
        address p = address(pool);
        address s = address(stock);
        address d = address(dollar);
        address c = address(chainlink);
        _expectSetup("pool");
        _new(makeAddr("no code"), s, d, c, 18, 6, WINDOW, FLOOR, 150, 12);
        _expectSetup("feed");
        _new(p, s, d, makeAddr("no code"), 18, 6, WINDOW, FLOOR, 150, 12);
        _expectSetup("tokens");
        _new(p, s, s, c, 18, 18, WINDOW, FLOOR, 150, 12);
        _expectSetup("window");
        _new(p, s, d, c, 18, 6, 599, FLOOR, 150, 12);
        _expectSetup("window");
        _new(p, s, d, c, 18, 6, 1 days + 1, FLOOR, 150, 12);
        _expectSetup("minLiquidity");
        _new(p, s, d, c, 18, 6, WINDOW, 0, 150, 12);
        _expectSetup("jumpBps");
        _new(p, s, d, c, 18, 6, WINDOW, FLOOR, 0, 12);
        _expectSetup("jumpBps");
        _new(p, s, d, c, 18, 6, WINDOW, FLOOR, 2001, 12);
        _expectSetup("maxRounds");
        _new(p, s, d, c, 18, 6, WINDOW, FLOOR, 150, 0);
        _expectSetup("maxRounds");
        _new(p, s, d, c, 18, 6, WINDOW, FLOOR, 150, 65);
        // A pool of other tokens than the two named.
        address other = address(new MockToken(18));
        _expectSetup("pool tokens");
        _new(p, other, d, c, 18, 6, WINDOW, FLOOR, 150, 12);
        // Decimals that are not the tokens' own.
        // A pool with no more observation slots than the window has seconds: 3,600 for an hour is one short.
        pool.setCardinality(3600);
        _expectSetup("pool cardinality");
        _new(p, s, d, c, 18, 6, WINDOW, FLOOR, 150, 12);
        pool.setCardinality(1801);
        _expectSetup("pool cardinality");
        _new(p, s, d, c, 18, 6, WINDOW, FLOOR, 150, 12);
        // 1,801 is enough for half an hour, and 3,601 for the hour.
        _new(p, s, d, c, 18, 6, 1800, FLOOR, 150, 12);
        pool.setCardinality(3601);
        _new(p, s, d, c, 18, 6, WINDOW, FLOOR, 150, 12);
        _expectSetup("base decimals");
        _new(p, s, d, c, 8, 6, WINDOW, FLOOR, 150, 12);
        _expectSetup("quote decimals");
        _new(p, s, d, c, 18, 18, WINDOW, FLOOR, 150, 12);
        _expectSetup("decimals");
        _new(p, s, d, c, 19, 6, WINDOW, FLOOR, 150, 12);
        chainlink.setDecimals(19);
        _expectSetup("feed decimals");
        _new(p, s, d, c, 18, 6, WINDOW, FLOOR, 150, 12);
    }

    // ---- across ticks

    /// Any tick the maths takes, both token orders: an answer or `PriceOutOfRange`, never a revert in
    /// `check`, and a dearer asset for a higher tick facing it.
    function testFuzz_check_neverReverts_andRisesWithTheTick(int24 tick, bool stockFirst) public {
        tick = int24(bound(int256(tick), -887_271, 887_271));
        vm.warp(START);
        MockV3Pool a = stockFirst
            ? new MockV3Pool(address(stock), address(dollar), tick, LIQUIDITY)
            : new MockV3Pool(address(dollar), address(stock), tick, LIQUIDITY);
        MockV3Pool b = stockFirst
            ? new MockV3Pool(address(stock), address(dollar), tick + 1, LIQUIDITY)
            : new MockV3Pool(address(dollar), address(stock), tick + 1, LIQUIDITY);
        PoolAverageFeed fa = _feed(a, stock, dollar);
        PoolAverageFeed fb = _feed(b, stock, dollar);
        vm.warp(START + WINDOW);
        (uint256 pa,,,,, PoolAverageFeed.Reason ra) = fa.check();
        (uint256 pb,,,,, PoolAverageFeed.Reason rb) = fb.check();
        assertTrue(ra == PoolAverageFeed.Reason.None || ra == PoolAverageFeed.Reason.PriceOutOfRange);
        assertTrue(rb == PoolAverageFeed.Reason.None || rb == PoolAverageFeed.Reason.PriceOutOfRange);
        assertEq(pa == 0, ra == PoolAverageFeed.Reason.PriceOutOfRange);
        assertLe(pa, type(uint128).max);
        if (pa != 0 && pb != 0) {
            // With the stock first a higher tick is a dearer stock; with the dollar first, a cheaper one.
            if (stockFirst) assertGe(pb, pa);
            else assertLe(pb, pa);
        }
    }

    /// What one read costs on the mocks, for the record. The real pool's `observe` is the larger part.
    function test_gas_ofOneRead() public {
        uint256 before = gasleft();
        feed.latestRoundData();
        console2.log("latestRoundData, quiet feed, gas:", before - gasleft());
        uint256 t = block.timestamp;
        for (uint256 i = 12; i > 0; --i) {
            chainlink.push(SPOT, t - i * 4 minutes);
        }
        before = gasleft();
        feed.latestRoundData();
        console2.log("latestRoundData, twelve rounds read, gas:", before - gasleft());
    }
}
