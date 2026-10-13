// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickPrice} from "./TickPrice.sol";

/// What this contract asks of a Uniswap v3 pool.
interface IOraclePool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function liquidity() external view returns (uint128);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// What this contract asks of a Chainlink price feed.
interface IRoundFeed {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IDecimals {
    function decimals() external view returns (uint8);
}

/// The second price a keeper trade is held to on a chain where Chainlink publishes no average
/// (ROBINHOOD-KEEPER-PRICES-DESIGN, `docs/vault/DESIGN-VAULT.md` section 5, check 8): one asset's
/// time-weighted average price in its Uniswap v3 pool against the dollar token, over the last `window`
/// seconds, in the Chainlink feed's decimals and behind Chainlink's `latestRoundData`. It goes in the
/// asset's `averageFeed` slot. The vault then requires Chainlink's price to be within `priceDevBps` of
/// where the token traded, and reads a revert here as `AssetNotPriced`.
///
/// One per asset. Nothing here can be changed: no owner, no setter, no upgrade, no storage. The admin
/// replaces it by naming another contract in `setAsset`.
///
/// `latestRoundData` reverts with the reason unless all of this holds:
///   - the pool still names the two tokens in the order it did at deployment, and the tokens and the feed
///     still state the decimals they did (`PoolChanged`);
///   - the Chainlink feed answers a price above zero (`FeedDown`);
///   - the pool's liquidity in range is at least `minLiquidity`, now and as the average of the window
///     (`ThinPool`). The average is the one the pool's own oracle keeps, which a deposit made for one block
///     cannot lift, and which a second spent at a price where the pool holds nothing brings to nearly zero;
///   - the pool has `window` seconds of history (`ShortHistory`). It is deployed only over a pool that
///     keeps more observations than the window has seconds, so trading the pool every second cannot
///     cause this;
///   - the average is a price this contract can state (`PriceOutOfRange`);
///   - Chainlink's own rounds of the last `window` can be read, at most `maxRounds` of them
///     (`FeedRounds`), and their time-weighted average is within `jumpBps` of the latest (`FeedJumped`):
///     a feed that has just stepped waits until the step is old.
///
/// The answer's time is the block's: the average runs up to the block it is read in, so it has no age of
/// its own, and the vault's `maxAge` on this slot always passes. What stands in for an age is
/// `ShortHistory` and the pool's own bookkeeping.
contract PoolAverageFeed {
    /// Why there is no answer. The order is the order the checks are made in: the first that fails is told.
    enum Reason {
        None,
        PoolChanged,
        FeedDown,
        ThinPool,
        ShortHistory,
        PriceOutOfRange,
        FeedRounds,
        FeedJumped
    }

    uint256 private constant BPS = 10_000;
    uint32 public constant MIN_WINDOW = 600;
    uint32 public constant MAX_WINDOW = 1 days;
    uint16 public constant MAX_JUMP_BPS = 2000;
    uint8 public constant MAX_ROUNDS = 64;
    uint8 public constant MAX_DECIMALS = 18;
    uint256 public constant version = 1;

    /// The Uniswap v3 pool of `base` against `quote`.
    address public immutable pool;
    /// The asset priced.
    address public immutable base;
    /// The dollar token it is priced in.
    address public immutable quote;
    /// The asset's Chainlink feed: the vault's `feed` for it.
    address public immutable feed;
    /// Seconds the average covers.
    uint32 public immutable window;
    /// The least in-range liquidity, in the pool's own units.
    uint128 public immutable minLiquidity;
    /// How far Chainlink's latest answer may be from its own average over the window.
    uint16 public immutable jumpBps;
    /// The most rounds before the latest that are read to work that average.
    uint8 public immutable maxRounds;
    uint8 public immutable baseDecimals;
    uint8 public immutable quoteDecimals;
    /// The feed's decimals, which are this contract's.
    uint8 public immutable decimals;
    bool public immutable baseIsToken0;

    address private immutable _token0;
    address private immutable _token1;
    /// A raw price times `_mulBy` over `_divBy` is dollars for one whole token in the feed's decimals.
    uint256 private immutable _mulBy;
    uint256 private immutable _divBy;

    error InvalidSetup(string what);
    error NotPriced(Reason reason);

    constructor(
        address pool_,
        address base_,
        address quote_,
        address feed_,
        uint8 baseDecimals_,
        uint8 quoteDecimals_,
        uint32 window_,
        uint128 minLiquidity_,
        uint16 jumpBps_,
        uint8 maxRounds_
    ) {
        require(pool_.code.length != 0, InvalidSetup("pool"));
        require(feed_.code.length != 0, InvalidSetup("feed"));
        require(base_ != quote_, InvalidSetup("tokens"));
        require(window_ >= MIN_WINDOW && window_ <= MAX_WINDOW, InvalidSetup("window"));
        require(minLiquidity_ != 0, InvalidSetup("minLiquidity"));
        require(jumpBps_ != 0 && jumpBps_ <= MAX_JUMP_BPS, InvalidSetup("jumpBps"));
        require(maxRounds_ != 0 && maxRounds_ <= MAX_ROUNDS, InvalidSetup("maxRounds"));

        address token0 = IOraclePool(pool_).token0();
        address token1 = IOraclePool(pool_).token1();
        bool base0 = token0 == base_ && token1 == quote_;
        require(base0 || (token0 == quote_ && token1 == base_), InvalidSetup("pool tokens"));
        // The pool keeps at most one observation a second, in as many slots as its cardinality, and the
        // number only grows. With more slots than the window has seconds, nobody can shorten its history
        // under the window by trading every second. Anyone may grow it first
        // (`increaseObservationCardinalityNext`); the new slots count once the pool has written into them.
        (,,, uint16 cardinality,,,) = IOraclePool(pool_).slot0();
        require(cardinality > window_, InvalidSetup("pool cardinality"));
        // The decimals are stated, as everywhere in these contracts, and here they are also held to what
        // the tokens say.
        require(baseDecimals_ <= MAX_DECIMALS && quoteDecimals_ <= MAX_DECIMALS, InvalidSetup("decimals"));
        require(IDecimals(base_).decimals() == baseDecimals_, InvalidSetup("base decimals"));
        require(IDecimals(quote_).decimals() == quoteDecimals_, InvalidSetup("quote decimals"));
        uint8 feedDecimals = IRoundFeed(feed_).decimals();
        require(feedDecimals <= MAX_DECIMALS, InvalidSetup("feed decimals"));

        pool = pool_;
        base = base_;
        quote = quote_;
        feed = feed_;
        window = window_;
        minLiquidity = minLiquidity_;
        jumpBps = jumpBps_;
        maxRounds = maxRounds_;
        baseDecimals = baseDecimals_;
        quoteDecimals = quoteDecimals_;
        decimals = feedDecimals;
        baseIsToken0 = base0;
        _token0 = token0;
        _token1 = token1;
        // Raw quote for one raw base, times 10^(base + feed - quote decimals).
        uint256 up = uint256(baseDecimals_) + feedDecimals;
        _mulBy = up >= quoteDecimals_ ? 10 ** (up - quoteDecimals_) : 1;
        _divBy = up >= quoteDecimals_ ? 1 : 10 ** (quoteDecimals_ - up);
    }

    /// Chainlink's shape, as the vault reads it: the average in the feed's decimals, stamped with the
    /// block's time. There are no rounds, so both round ids are zero. Reverts with the reason when there is
    /// no answer.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (uint256 average,,,,, Reason reason) = check();
        require(reason == Reason.None, NotPriced(reason));
        // `check` holds the average to 128 bits.
        return (0, int256(average), block.timestamp, block.timestamp, 0);
    }

    /// The feed's own description, marked as the pool's average of it.
    function description() external view returns (string memory) {
        try IRoundFeed(feed).description() returns (string memory name) {
            return string.concat(name, " (pool average)");
        } catch {
            return "pool average";
        }
    }

    /// Everything `latestRoundData` decides on, for the keeper and the app, without reverting: the pool's
    /// average, Chainlink's latest answer and its own average over the window (all in the feed's decimals,
    /// zero where one could not be worked out), the pool's liquidity in range now and averaged over the
    /// window, and the first reason there is no answer.
    function check()
        public
        view
        returns (
            uint256 average,
            uint256 spot,
            uint256 ownAverage,
            uint128 liquidity,
            uint128 meanLiquidity,
            Reason reason
        )
    {
        if (!_unchanged()) return (0, 0, 0, 0, 0, Reason.PoolChanged);

        uint80 roundId;
        uint256 spotAt;
        (roundId, spot, spotAt) = _latest();
        if (spot == 0) reason = Reason.FeedDown;

        bool ok;
        uint256 word;
        (ok, word) = _word(pool, IOraclePool.liquidity.selector);
        liquidity = ok && word <= type(uint128).max ? uint128(word) : 0;
        if (reason == Reason.None && liquidity < minLiquidity) reason = Reason.ThinPool;

        int256 tick;
        (ok, tick, meanLiquidity) = _observed();
        if (!ok) {
            if (reason == Reason.None) reason = Reason.ShortHistory;
        } else {
            if (reason == Reason.None && meanLiquidity < minLiquidity) reason = Reason.ThinPool;
            if (tick >= -TickPrice.MAX_TICK && tick <= TickPrice.MAX_TICK) {
                average = TickPrice.priceAt(tick, _mulBy, _divBy);
            }
            // The vault takes an average of at most 128 bits.
            if (average > type(uint128).max) average = 0;
            if (reason == Reason.None && average == 0) reason = Reason.PriceOutOfRange;
        }

        if (spot != 0) {
            Reason rounds;
            (ownAverage, rounds) = _ownAverage(roundId, spot, spotAt);
            if (reason == Reason.None) reason = rounds;
        }
    }

    /// The pool names the same two tokens in the same order, and the tokens and the feed state the same
    /// decimals, as at deployment. A Uniswap pool cannot change its tokens; a token or a feed behind a
    /// proxy can change what it says.
    function _unchanged() private view returns (bool) {
        (bool ok, uint256 word) = _word(pool, IOraclePool.token0.selector);
        if (!ok || word != uint160(_token0)) return false;
        (ok, word) = _word(pool, IOraclePool.token1.selector);
        if (!ok || word != uint160(_token1)) return false;
        (ok, word) = _word(base, IDecimals.decimals.selector);
        if (!ok || word != baseDecimals) return false;
        (ok, word) = _word(quote, IDecimals.decimals.selector);
        if (!ok || word != quoteDecimals) return false;
        (ok, word) = _word(feed, IDecimals.decimals.selector);
        return ok && word == decimals;
    }

    /// Chainlink's latest round: its id, its answer and its time. A zero answer stands for a feed that
    /// does not answer as one, answers zero or below or more than 128 bits, or is stamped ahead of the clock.
    function _latest() private view returns (uint80 roundId, uint256 answer, uint256 updatedAt) {
        (bool ok, uint256 id, int256 signed, uint256 stamp) =
            _round(abi.encodeWithSelector(IRoundFeed.latestRoundData.selector));
        if (!ok || id > type(uint80).max || stamp > block.timestamp) return (0, 0, 0);
        return (uint80(id), uint256(signed), stamp);
    }

    /// The pool's average tick over the window, turned to face the asset and rounded down, and its average
    /// liquidity in range over the same seconds. `ok` is false when the pool has less history than the
    /// window or does not answer as a Uniswap v3 pool.
    function _observed() private view returns (bool ok, int256 tick, uint128 meanLiquidity) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        bytes memory ret;
        (ok, ret) = pool.staticcall(abi.encodeWithSelector(IOraclePool.observe.selector, ago));
        // Two arrays of two words each: two offsets, then a length and two words, twice.
        if (!ok || ret.length != 256) return (false, 0, 0);
        uint256 tickThen;
        uint256 tickNow;
        uint256 perLiquidityThen;
        uint256 perLiquidityNow;
        bool shaped;
        assembly ("memory-safe") {
            let data := add(ret, 0x20)
            shaped :=
                and(
                    and(eq(mload(data), 0x40), eq(mload(add(data, 0x20)), 0xa0)),
                    and(eq(mload(add(data, 0x40)), 2), eq(mload(add(data, 0xa0)), 2))
                )
            tickThen := mload(add(data, 0x60))
            tickNow := mload(add(data, 0x80))
            perLiquidityThen := mload(add(data, 0xc0))
            perLiquidityNow := mload(add(data, 0xe0))
        }
        if (!shaped) return (false, 0, 0);

        int256 moved;
        uint256 perLiquidity;
        unchecked {
            // Both counters wrap by design, in 56 and in 160 bits: the difference is taken in that width.
            moved = int256(int56(int256(tickNow)) - int56(int256(tickThen)));
            perLiquidity = uint256(uint160(perLiquidityNow) - uint160(perLiquidityThen));
        }
        // The pool's tick is its token1 for a token0. Facing the asset, a higher tick is a dearer asset,
        // and rounding toward minus infinity rounds the asset's price down, whichever token it is.
        int256 facing = baseIsToken0 ? moved : -moved;
        int256 span = int256(uint256(window));
        tick = facing / span;
        if (facing < 0 && facing % span != 0) --tick;

        // The pool adds seconds over liquidity, counting no liquidity as one unit: seconds over that sum
        // is the harmonic mean, which a moment with nothing in range pulls to nearly nothing.
        uint256 mean = perLiquidity == 0 ? type(uint128).max : (uint256(window) << 128) / perLiquidity;
        meanLiquidity = uint128(Math.min(mean, type(uint128).max));
        return (true, tick, meanLiquidity);
    }

    /// Chainlink's own answers weighted by the time each stood, over the window, and whether the latest
    /// is within `jumpBps` of that. When the latest round is older than the window it stood for all of
    /// it, and nothing more is read.
    function _ownAverage(uint80 roundId, uint256 latest, uint256 latestAt)
        private
        view
        returns (uint256 ownAverage, Reason reason)
    {
        uint256 start = block.timestamp > window ? block.timestamp - window : 0;
        uint256 upper = Math.max(latestAt, start);
        uint256 weighted = latest * (block.timestamp - upper);
        bool covered = latestAt <= start;
        for (uint256 i; !covered && i < maxRounds; ++i) {
            // The round before, in the same aggregator. A feed that moved to a new aggregator inside the
            // window has no round before its first: it waits until that round is a window old.
            if (roundId == 0) return (0, Reason.FeedRounds);
            --roundId;
            (bool ok,, int256 answer, uint256 stamp) =
                _round(abi.encodeWithSelector(IRoundFeed.getRoundData.selector, roundId));
            if (!ok || stamp > upper) return (0, Reason.FeedRounds);
            uint256 lower = Math.max(stamp, start);
            weighted += uint256(answer) * (upper - lower);
            upper = lower;
            covered = stamp <= start;
        }
        if (!covered) return (0, Reason.FeedRounds);
        ownAverage = weighted / window;
        uint256 apart = latest > ownAverage ? latest - ownAverage : ownAverage - latest;
        if (apart * BPS > ownAverage * jumpBps) reason = Reason.FeedJumped;
    }

    /// One round of the Chainlink feed. `ok` is false for a call that fails or answers short, an answer of
    /// zero, below zero or over 128 bits, or a time of zero.
    function _round(bytes memory call) private view returns (bool ok, uint256 id, int256 answer, uint256 stamp) {
        bytes memory ret;
        (ok, ret) = feed.staticcall(call);
        if (!ok || ret.length < 160) return (false, 0, 0, 0);
        (id, answer,, stamp,) = abi.decode(ret, (uint256, int256, uint256, uint256, uint256));
        ok = answer > 0 && uint256(answer) <= type(uint128).max && stamp != 0;
    }

    /// One word from a view that takes no argument; a revert or a short answer is `ok == false`.
    function _word(address target, bytes4 selector) private view returns (bool ok, uint256 word) {
        bytes memory ret;
        (ok, ret) = target.staticcall(abi.encodeWithSelector(selector));
        if (!ok || ret.length < 32) return (false, 0);
        word = abi.decode(ret, (uint256));
    }
}
