// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// A Uniswap v4 pool's key. `Currency` and `IHooks` are addresses in the ABI.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// What this contract needs of Uniswap v4's PoolManager (v4-core 1.0, the code on Robinhood Chain and its
/// test network at 0x8366a39CC670B4001A1121B8F6A443A643e40951). A `BalanceDelta` is an int256 holding
/// amount0 in its upper 128 bits and amount1 in its lower 128.
interface IPoolManagerLite {
    struct ModifyLiquidityParams {
        int24 tickLower;
        int24 tickUpper;
        int256 liquidityDelta;
        bytes32 salt;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32 value);
}

/// The calls of a test token this contract makes: it mints what a pool is owed and burns what it takes.
interface ITestTokenSupply {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

/// TEST NETWORK ONLY. The test network's market maker for its Uniswap v4 pools: one hookless pool per test
/// stock token against the test cash, opened at the token's test price, seeded with liquidity over the whole
/// range, and moved back to the test price when trades or the market have pulled it away.
///
/// It holds the minter role on the test tokens, so it never holds an inventory: what a pool is owed it mints
/// straight to the PoolManager, and what it takes out it burns. Only the owner opens and seeds a pool. The
/// owner or the operator (the price copier's key) re-centres one, and only ever to the price the token's own
/// test price contract holds: neither can name a price.
///
/// A real token's pool is never re-centred: this is how a test exchange follows a copied price, as the
/// Solana test exchange pays at the test price (TNET-4).
contract TestMarket is TestnetOnly, Ownable2Step {
    using SafeCast for uint256;

    /// v4-core's `TickMath` bounds.
    int24 internal constant MIN_TICK = -887_272;
    int24 internal constant MAX_TICK = 887_272;
    uint160 internal constant MIN_SQRT_PRICE = 4_295_128_739;
    uint160 internal constant MAX_SQRT_PRICE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;
    /// v4-core's `StateLibrary`: the pools mapping sits in slot 6, a pool's liquidity three slots after its
    /// `slot0`.
    bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));
    uint256 internal constant LIQUIDITY_OFFSET = 3;
    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant BPS = 10_000;
    /// Exact input with no real bound: a re-centring swap stops at its price limit.
    int256 internal constant UNBOUNDED_IN = -int256(uint256(type(uint120).max));

    uint8 internal constant ACTION_SEED = 1;
    uint8 internal constant ACTION_SWAP = 2;

    IPoolManagerLite public immutable poolManager;
    address public immutable cash;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    /// A pool closer to its test price than this is left as it is.
    uint16 public immutable driftBps;

    address public operator;
    /// The test price contract each listed token's pool follows.
    mapping(address token => address feed) public feedOf;

    event OperatorSet(address indexed operator);
    event FeedSet(address indexed token, address indexed feed);
    event Opened(address indexed token, bytes32 indexed poolId, uint160 sqrtPriceX96);
    event Seeded(address indexed token, uint128 liquidity);
    event Recentred(address indexed token, uint160 fromSqrtPriceX96, uint160 toSqrtPriceX96);

    error NotOperator(address caller);
    error NotPoolManager(address caller);
    error NoFeed(address token);
    error NoPrice(address token);
    error PriceOutOfBounds(address token, uint256 sqrtPriceX96);
    error PoolNotOpen(address token);
    error PoolOpenElsewhere(address token, uint160 sqrtPriceX96, uint160 testSqrtPriceX96);
    error ZeroAmount();

    constructor(
        address owner_,
        IPoolManagerLite poolManager_,
        address cash_,
        uint24 fee_,
        int24 tickSpacing_,
        uint16 driftBps_
    ) Ownable(owner_) {
        poolManager = poolManager_;
        cash = cash_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        driftBps = driftBps_;
    }

    // ---- the owner's settings

    function setOperator(address operator_) external onlyOwner {
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setFeed(address token, address feed) external onlyOwner {
        feedOf[token] = feed;
        emit FeedSet(token, feed);
    }

    // ---- the pools

    /// The pool of `token` against the test cash: hookless, at this market's fee and tick spacing.
    function poolKey(address token) public view returns (PoolKey memory key) {
        (address a, address b) = token < cash ? (token, cash) : (cash, token);
        return PoolKey({currency0: a, currency1: b, fee: fee, tickSpacing: tickSpacing, hooks: address(0)});
    }

    function poolId(address token) public view returns (bytes32) {
        return keccak256(abi.encode(poolKey(token)));
    }

    /// The pool's price now, as v4 holds it; zero for a pool not yet opened.
    function poolSqrtPrice(address token) public view returns (uint160) {
        bytes32 slot0 = poolManager.extsload(_stateSlot(token));
        return uint160(uint256(slot0));
    }

    function poolLiquidity(address token) public view returns (uint128) {
        return uint128(uint256(poolManager.extsload(bytes32(uint256(_stateSlot(token)) + LIQUIDITY_OFFSET))));
    }

    /// The pool's price that matches the token's test price: v4's square root of currency1 per currency0
    /// in raw units, times 2^96.
    function testSqrtPrice(address token) public view returns (uint160) {
        address feed = feedOf[token];
        require(feed != address(0), NoFeed(token));
        (bool ok, bytes memory ret) = feed.staticcall(abi.encodeWithSignature("latestRoundData()"));
        require(ok && ret.length >= 160, NoPrice(token));
        (, int256 answer,,,) = abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
        require(answer > 0, NoPrice(token));
        uint256 one = 10 ** uint256(IERC20Metadata(feed).decimals());
        uint256 tokenUnit = 10 ** uint256(IERC20Metadata(token).decimals());
        uint256 cashUnit = 10 ** uint256(IERC20Metadata(cash).decimals());
        // Cash per token in raw units is answer * cashUnit / (one * tokenUnit).
        (uint256 num, uint256 den) =
            token < cash ? (uint256(answer) * cashUnit, one * tokenUnit) : (one * tokenUnit, uint256(answer) * cashUnit);
        uint256 sqrtPrice = Math.sqrt(Math.mulDiv(num, 2 ** 192, den));
        require(sqrtPrice >= MIN_SQRT_PRICE && sqrtPrice < MAX_SQRT_PRICE, PriceOutOfBounds(token, sqrtPrice));
        return uint160(sqrtPrice);
    }

    /// Opens the pool at the test price. The pool's key is predictable, so someone may open it first at
    /// another price: while it holds no liquidity, a swap moves it to the test price for nothing; a pool
    /// someone has also put liquidity in away from the test price is refused, since this contract's
    /// liquidity would go in at their price.
    function open(address token) external onlyOwner {
        uint160 target = testSqrtPrice(token);
        uint160 current = poolSqrtPrice(token);
        if (current == 0) {
            poolManager.initialize(poolKey(token), target);
            emit Opened(token, poolId(token), target);
            return;
        }
        if (_apartBps(current, target) <= driftBps) return;
        require(poolLiquidity(token) == 0, PoolOpenElsewhere(token, current, target));
        poolManager.unlock(abi.encode(ACTION_SWAP, token, uint256(target)));
        emit Recentred(token, current, poolSqrtPrice(token));
    }

    /// Adds `cashPerSide` worth of liquidity over the whole range at the pool's price: about that much cash
    /// and that much of the token at its price. The tokens are minted to the PoolManager.
    function seed(address token, uint256 cashPerSide) external onlyOwner returns (uint128 liquidity) {
        require(cashPerSide != 0, ZeroAmount());
        uint160 price = poolSqrtPrice(token);
        require(price != 0, PoolNotOpen(token));
        // For the whole range, the cash side is about L * sqrtP / 2^96 as currency1, or L * 2^96 / sqrtP as
        // currency0.
        liquidity =
            (token < cash ? Math.mulDiv(cashPerSide, Q96, price) : Math.mulDiv(cashPerSide, price, Q96)).toUint128();
        require(liquidity != 0, ZeroAmount());
        poolManager.unlock(abi.encode(ACTION_SEED, token, liquidity));
        emit Seeded(token, liquidity);
    }

    /// Moves the pool back to the test price when it sits further from it than `driftBps`. Answers whether
    /// it swapped.
    /// How far the pool sits from the token's test price, in bps of the test price; what `recentre` judges.
    function driftOf(address token) external view returns (uint256) {
        uint160 current = poolSqrtPrice(token);
        require(current != 0, PoolNotOpen(token));
        return _apartBps(current, testSqrtPrice(token));
    }

    function recentre(address token) external returns (bool moved) {
        require(msg.sender == operator || msg.sender == owner(), NotOperator(msg.sender));
        uint160 current = poolSqrtPrice(token);
        require(current != 0, PoolNotOpen(token));
        uint160 target = testSqrtPrice(token);
        if (_apartBps(current, target) <= driftBps) return false;
        poolManager.unlock(abi.encode(ACTION_SWAP, token, uint256(target)));
        emit Recentred(token, current, poolSqrtPrice(token));
        return true;
    }

    /// The PoolManager's call back inside `unlock`: the liquidity or the swap, then every delta settled.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), NotPoolManager(msg.sender));
        (uint8 action, address token, uint256 amount) = abi.decode(data, (uint8, address, uint256));
        PoolKey memory key = poolKey(token);
        int256 delta;
        if (action == ACTION_SEED) {
            int24 lower = (MIN_TICK / tickSpacing) * tickSpacing;
            int24 upper = (MAX_TICK / tickSpacing) * tickSpacing;
            (delta,) = poolManager.modifyLiquidity(
                key,
                IPoolManagerLite.ModifyLiquidityParams({
                    tickLower: lower,
                    tickUpper: upper,
                    liquidityDelta: int256(amount),
                    salt: bytes32(0)
                }),
                ""
            );
        } else {
            bool zeroForOne = poolSqrtPrice(token) > amount;
            delta = poolManager.swap(
                key,
                IPoolManagerLite.SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: UNBOUNDED_IN,
                    sqrtPriceLimitX96: uint160(amount)
                }),
                ""
            );
        }
        _settle(key.currency0, int128(delta >> 128));
        _settle(key.currency1, int128(delta));
        return "";
    }

    /// Pays what the pool is owed by minting it there, or takes what it owes and burns it.
    function _settle(address currency, int128 amount) private {
        if (amount < 0) {
            poolManager.sync(currency);
            ITestTokenSupply(currency).mint(address(poolManager), uint256(uint128(-amount)));
            poolManager.settle();
        } else if (amount > 0) {
            poolManager.take(currency, address(this), uint256(uint128(amount)));
            ITestTokenSupply(currency).burn(address(this), uint256(uint128(amount)));
        }
    }

    function _stateSlot(address token) private view returns (bytes32) {
        return keccak256(abi.encodePacked(poolId(token), POOLS_SLOT));
    }

    /// How far apart two prices are, in bps of `b`: the square roots are squared back.
    function _apartBps(uint160 a, uint160 b) private pure returns (uint256) {
        uint256 pa = Math.mulDiv(a, a, Q96);
        uint256 pb = Math.mulDiv(b, b, Q96);
        uint256 apart = pa > pb ? pa - pb : pb - pa;
        return Math.mulDiv(apart, BPS, pb);
    }
}
