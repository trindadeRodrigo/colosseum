// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {IBasketVault} from "../src/interfaces/IBasketVault.sol";
import {AssetConfig, Swap} from "../src/interfaces/Types.sol";
import {PoolAverageFeed} from "../src/price/PoolAverageFeed.sol";
import {KeeperFixture} from "./helpers/KeeperFixture.sol";
import {MockRoundFeed} from "./mocks/Feeds.sol";
import {MockV3Pool} from "./mocks/Pools.sol";

/// The vault's keeper path with `PoolAverageFeed` in an asset's `averageFeed` slot: stock A is priced by a
/// Chainlink feed with rounds, and its second price is the hour's average of a pool against the cash token.
/// The vault itself is unchanged; these are checks 8 of section 5 read through the new contract, and what
/// moving the pool can and cannot do to a keeper trade.
///
/// The fixture's keeper limits, with the distance between a price and its average at the 150 bps the
/// design starts mainnet with. The pool sits at $100.0002 and has done for an hour; the clock is Monday
/// 16:00 UTC.
contract PoolAverageFeedVaultTest is KeeperFixture {
    uint32 internal constant WINDOW = 3600;
    uint128 internal constant LIQUIDITY = 7e18;
    /// The asset's price as a tick facing it: 1.0001^-230270 * 10^20 is 100.00022031 in 8 decimals.
    int24 internal constant FACING = -230_270;
    uint256 internal constant POOL_PRICE = 10000022031;
    /// 5% in ticks: 1.0001^488 is 1.0500.
    int24 internal constant FIVE_PERCENT = 488;

    MockRoundFeed internal chainlink;
    MockV3Pool internal pool;
    PoolAverageFeed internal poolFeed;
    bool internal stockFirst;

    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function setUp() public {
        _deployKeeperPlatform();
        vm.prank(admin);
        factory.setPriceDevBps(150);

        chainlink = new MockRoundFeed();
        chainlink.push(int256(PRICE_A), block.timestamp - 2 hours);
        // A Uniswap pool orders its two tokens by address.
        stockFirst = address(stockA) < address(cash);
        pool = stockFirst
            ? new MockV3Pool(address(stockA), address(cash), _tick(FACING), LIQUIDITY)
            : new MockV3Pool(address(cash), address(stockA), _tick(FACING), LIQUIDITY);
        poolFeed = new PoolAverageFeed(
            address(pool), address(stockA), address(cash), address(chainlink), 18, 6, WINDOW, LIQUIDITY / 2, 150, 12
        );
        AssetConfig memory a = factory.asset(address(stockA));
        a.feed = address(chainlink);
        a.averageFeed = address(poolFeed);
        vm.prank(admin);
        factory.setAsset(address(stockA), a);

        vm.warp(block.timestamp + WINDOW);
    }

    /// The pool's own tick for a tick facing the asset.
    function _tick(int24 facing) internal view returns (int24) {
        return stockFirst ? facing : -facing;
    }

    function _average() internal view returns (uint256 average) {
        (average,,,,,) = poolFeed.check();
    }

    /// Chainlink's price for stock A, written long enough ago that its own rounds say nothing: the case
    /// only the pool can catch. The fixture's router fills at the same price.
    function _chainlinkSays(uint256 price) internal {
        chainlink.nextPhase();
        chainlink.push(int256(price), block.timestamp - 2 hours);
        feedA.set(int256(price), block.timestamp);
    }

    function _buyA() internal view returns (Swap memory) {
        return _buy(direct, address(stockA), 4000 * USD, 0);
    }

    function _notPriced() internal view returns (bytes memory) {
        return abi.encodeWithSelector(IBasketVault.AssetNotPriced.selector, address(stockA));
    }

    function _deviation(uint256 price, uint256 average) internal view returns (bytes memory) {
        return abi.encodeWithSelector(IBasketVault.PriceDeviation.selector, address(stockA), price, average);
    }

    // ---- the vault reads it as it reads any average

    function test_keeperSwap_withThePoolAverageInTheSlot() public {
        assertEq(_average(), POOL_PRICE);
        vm.expectEmit(address(vault));
        emit IBasketVault.KeeperTrade(address(vault), address(cash), address(stockA), 4000 * USD, 40 * unit, 0, 0);
        _keeperSwap(_buyA());
    }

    /// Chainlink more than 150 bps from where the token traded over the hour, either side.
    function test_keeperSwap_chainlinkFarFromThePool_isRefused() public {
        _chainlinkSays(101.6e8);
        _expectKeeperRevert(_buyA(), _deviation(101.6e8, POOL_PRICE));
        _chainlinkSays(98.4e8);
        _expectKeeperRevert(_buyA(), _deviation(98.4e8, POOL_PRICE));
        _chainlinkSays(101.4e8);
        _keeperSwap(_buyA());
    }

    /// Every reason the feed gives no answer reaches the keeper as `AssetNotPriced`.
    function test_keeperSwap_noAnswerFromThePoolFeed_isRefused() public {
        // The pool is thin.
        pool.move(_tick(FACING), LIQUIDITY / 2 - 1);
        _expectKeeperRevert(_buyA(), _notPriced());
        pool.move(_tick(FACING), LIQUIDITY);
        // The pool has less than an hour of history.
        pool.restart();
        _expectKeeperRevert(_buyA(), _notPriced());
        vm.warp(block.timestamp + WINDOW);
        _refresh();
        // Chainlink has just stepped 5%.
        chainlink.push(105e8, block.timestamp - 1 minutes);
        _expectKeeperRevert(_buyA(), _notPriced());
        // The pool names other tokens than it did.
        chainlink.nextPhase();
        chainlink.push(int256(PRICE_A), block.timestamp - 2 hours);
        pool.setTokens(pool.token1(), pool.token0());
        _expectKeeperRevert(_buyA(), _notPriced());
        pool.setTokens(pool.token1(), pool.token0());
        _keeperSwap(_buyA());
    }

    /// A target the vault holds and does not trade is valued through its own pool average too: stock B's
    /// trade is refused while stock A's pool is thin.
    function test_keeperSwap_anotherHeldTargetsPoolFeedRefusing_isRefused() public {
        _keeperSwap(_buyA());
        pool.move(_tick(FACING), 1);
        _expectKeeperRevert(_buy(direct, address(stockB), 3000 * USD, 0), _notPriced());
    }

    /// I4: the owner's path reads none of it.
    function test_I4_theOwnersPath_ignoresThePoolFeed() public {
        pool.setBroken(true);
        chainlink.setBroken(true);
        _expectKeeperRevert(_buyA(), _notPriced());
        Swap[] memory swaps = new Swap[](1);
        swaps[0] = _swap(direct, address(cash), address(stockA), 1000 * USD, 10 * unit);
        vm.startPrank(owner);
        vault.ownerSwap(swaps, LATER);
        vault.withdraw(address(stockA), 10 * unit);
        vm.stopPrank();
        assertEq(stockA.balanceOf(owner), 10 * unit);
    }

    // ---- moving the pool
    //
    // The keeper's price check is an AND: Chainlink inside its range and fresh, the pool feed answering,
    // and the two within 150 bps. Whoever moves the pool changes only the second and third. With Chainlink
    // right, that can stop a trade and nothing else; with Chainlink wrong, it has to hold the pool at the
    // wrong price for most of an hour.

    /// Chainlink is right. The pool is pushed 5% for one block and put back: the hour's average moves by
    /// under a hundredth of a percent and the keeper's honest trade still passes.
    function test_manipulation_aPushOfOneBlock_changesNothing() public {
        pool.moveTick(_tick(FACING + FIVE_PERCENT));
        vm.warp(block.timestamp + 2);
        pool.moveTick(_tick(FACING));
        uint256 average = _average();
        assertApproxEqAbs(average, POOL_PRICE, POOL_PRICE / 10_000 + 1);
        _keeperSwap(_buyA());
    }

    /// Chainlink is right. The pool is held 5% away for half an hour: the keeper refuses. It trades again
    /// once the pool has been back for long enough.
    function test_manipulation_aPushThatIsHeld_canOnlyStopTheKeeper() public {
        pool.moveTick(_tick(FACING + FIVE_PERCENT));
        vm.warp(block.timestamp + 30 minutes);
        _refresh();
        uint256 average = _average();
        assertGt(average, POOL_PRICE * 102 / 100);
        _expectKeeperRevert(_buyA(), _deviation(PRICE_A, average));
        pool.moveTick(_tick(FACING));
        vm.warp(block.timestamp + 50 minutes);
        _refresh();
        _keeperSwap(_buyA());
    }

    /// Chainlink is wrong by 5% and has been for hours, so its own rounds show no step. Nobody touches
    /// the pool: refused, because the token did not trade there.
    function test_manipulation_aWrongChainlinkPrice_isRefusedByThePool() public {
        _chainlinkSays(105e8);
        _expectKeeperRevert(_buyA(), _deviation(105e8, POOL_PRICE));
        _chainlinkSays(95e8);
        _expectKeeperRevert(_buyA(), _deviation(95e8, POOL_PRICE));
    }

    /// Chainlink is wrong by 5% and a keeper key is stolen. The thief pushes the pool, by anything up to
    /// 100,000 ticks (a price 22,000 times higher or lower), for anything up to twelve seconds, and leaves
    /// it there or puts it back: the trade at Chainlink's price is still refused.
    function testFuzz_manipulation_aPushOfSeconds_cannotPassAWrongChainlinkPrice(
        int24 push,
        uint8 held,
        bool putBack,
        bool high
    ) public {
        push = int24(bound(int256(push), -100_000, 100_000));
        uint256 seconds_ = bound(held, 0, 12);
        uint256 wrong = high ? 105e8 : 95e8;
        _chainlinkSays(wrong);

        pool.moveTick(_tick(FACING + push));
        vm.warp(block.timestamp + seconds_);
        if (putBack) pool.moveTick(_tick(FACING));

        (uint256 average,,,,, PoolAverageFeed.Reason reason) = poolFeed.check();
        assertEq(uint8(reason), uint8(PoolAverageFeed.Reason.None));
        _expectKeeperRevert(_buyA(), _deviation(wrong, average));
    }

    /// The same thief pushes the price past the last of the pool's liquidity, where one second moves the
    /// average of the ticks a long way. The pool holds nothing there, so that second takes the hour's
    /// average liquidity to almost nothing: no answer, and the trade is refused.
    function test_manipulation_aPushPastTheLiquidity_isNoAnswer() public {
        _chainlinkSays(105e8);
        pool.move(_tick(FACING + 400_000), 0);
        vm.warp(block.timestamp + 1);
        pool.move(_tick(FACING), LIQUIDITY);
        (uint256 average,,,,, PoolAverageFeed.Reason reason) = poolFeed.check();
        // One second at 400,000 ticks away moved the average tick by 111: over 1%.
        assertGt(average, POOL_PRICE * 101 / 100);
        assertEq(uint8(reason), uint8(PoolAverageFeed.Reason.ThinPool));
        _expectKeeperRevert(_buyA(), _notPriced());
    }

    /// A Chainlink price that is wrong because it has just stepped is refused whatever the pool says: the
    /// thief holds the pool at the wrong price for the whole hour and it does not help.
    function test_manipulation_aFreshChainlinkStep_isRefusedWhateverThePoolSays() public {
        pool.moveTick(_tick(FACING + FIVE_PERCENT));
        vm.warp(block.timestamp + WINDOW);
        _refresh();
        chainlink.push(105e8, block.timestamp - 5 minutes);
        feedA.set(105e8, block.timestamp);
        (uint256 average, uint256 spot,,,, PoolAverageFeed.Reason reason) = poolFeed.check();
        assertApproxEqRel(average, spot, 0.001e18, "the pool agrees with the wrong price");
        assertEq(uint8(reason), uint8(PoolAverageFeed.Reason.FeedJumped));
        _expectKeeperRevert(_buyA(), _notPriced());
    }

    /// What is left, as the design names it: Chainlink wrong and steady, and the pool held at the wrong
    /// price for most of an hour against everyone who would trade it back. At 40 minutes the trade is
    /// still refused; at 45 it passes, at Chainlink's price.
    function test_manipulation_whatIsLeft_bothWrongForMostOfAnHour() public {
        _chainlinkSays(105e8);
        pool.moveTick(_tick(FACING + FIVE_PERCENT));
        vm.warp(block.timestamp + 40 minutes);
        _refresh();
        feedA.set(105e8, block.timestamp);
        _expectKeeperRevert(_buyA(), _deviation(105e8, _average()));
        vm.warp(block.timestamp + 5 minutes);
        _keeperSwap(_buyA());
    }
}
