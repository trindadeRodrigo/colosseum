// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {console2} from "forge-std/console2.sol";
import {IBasketVault} from "../../src/interfaces/IBasketVault.sol";
import {AssetConfig, Params, Swap, Weight} from "../../src/interfaces/Types.sol";
import {PoolAverageFeed} from "../../src/price/PoolAverageFeed.sol";
import {VaultFixture} from "../helpers/VaultFixture.sol";
import {UniV4Calldata} from "./UniV4Calldata.sol";

interface IErc20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IChainlink {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80);
    function description() external view returns (string memory);
}

interface IV3Pool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface IV3Factory {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}

/// `PoolAverageFeed` against Robinhood Chain as it was: the real NVDA and SPY pools against USDG on
/// Uniswap v3, the real Chainlink feeds, the real tokens and the real Universal Router.
///
/// Opt-in: every test here is skipped unless `RH_FORK_URL` names a node that keeps old state, for example
///   RH_FORK_URL=https://robinhood.drpc.org pnpm test:contracts
/// The chain's own public node drops a block's state within minutes and cannot serve these. Nothing is
/// sent to any network.
abstract contract RobinhoodForkPoolFeedBase is VaultFixture {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address internal constant NVDA_FEED = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
    address internal constant SPY_FEED = 0x319724394D3A0e3669269846abE664Cd621f9f6A;
    /// Both at the 0.05% fee, from `getPool` on the v3 factory. USDG is token0 of the NVDA pool and token1
    /// of the SPY pool, so the two cover both token orders.
    address internal constant NVDA_POOL = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3;
    address internal constant SPY_POOL = 0xa7Bb1AC63BBaB0C44316E6c8C455213441689167;
    address internal constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant UNIVERSAL_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498;

    uint32 internal constant WINDOW = 3600;
    uint16 internal constant BAND = 150;

    bool internal forked;
    PoolAverageFeed internal nvdaAverage;
    PoolAverageFeed internal spyAverage;

    modifier onFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _block() internal pure virtual returns (uint256);

    function setUp() public virtual {
        string memory url = vm.envOr("RH_FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        forked = true;
        vm.createSelectFork(url, _block());
        // The floors: about half of each pool's average liquidity in range over the hour before.
        nvdaAverage = new PoolAverageFeed(NVDA_POOL, NVDA, USDG, NVDA_FEED, 18, 6, WINDOW, 1.8e18, BAND, 12);
        spyAverage = new PoolAverageFeed(SPY_POOL, SPY, USDG, SPY_FEED, 18, 6, WINDOW, 1.1e17, BAND, 12);
    }

    function _spot(address feed_) internal view returns (uint256 answer, uint256 updatedAt) {
        (, int256 signed,, uint256 stamp,) = IChainlink(feed_).latestRoundData();
        return (uint256(signed), stamp);
    }

    function _gapBps(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a > b ? a - b : b - a) * 10_000 / b;
    }

    function _log(string memory name, PoolAverageFeed f) internal view {
        (uint256 average, uint256 spot, uint256 own, uint128 liquidity, uint128 mean, PoolAverageFeed.Reason reason) =
            f.check();
        console2.log(name);
        console2.log("  pool average (8 decimals):", average);
        console2.log("  Chainlink latest:", spot);
        console2.log("  Chainlink's own average over the hour:", own);
        console2.log("  gap between the two, bps:", average == 0 ? 0 : _gapBps(spot, average));
        console2.log("  liquidity in range now:", liquidity);
        console2.log("  liquidity in range, the hour's average:", mean);
        console2.log("  reason (0 is none):", uint8(reason));
    }
}

/// Friday 2026-10-09 at 16:30:00 UTC, inside the session. NVDA's last Chainlink round is 81 minutes old
/// and SPY's 18 hours: neither feed stepped inside the hour.
contract RobinhoodForkPoolFeedTest is RobinhoodForkPoolFeedBase {
    /// sqrt(1.0001^221461) * 2^96: the NVDA pool's price 488 ticks under where it stood, which is NVDA
    /// 5% dearer in dollars.
    uint160 internal constant PUSHED = 5100393274267060838646073745382964;

    function _block() internal pure override returns (uint256) {
        return 84_298_619;
    }

    function setUp() public override {
        super.setUp();
        if (!forked) return;
        _deployPlatform();

        // The platform as the mainnet file would write it for these two: real tokens, real feeds, the
        // pool average in the average slot, the keeper's switch on, a range of 15% either side, the
        // tokens' own pause and schedule, and the design's session and distance.
        vm.startPrank(admin);
        factory.setParams(
            Params({
                toleranceBps: 125,
                lossCapBps: 100,
                bandBps: 50,
                assetCooldown: 3600,
                sessionOpen: 54_000,
                sessionClose: 71_100
            })
        );
        factory.setPriceDevBps(BAND);
        factory.setAsset(USDG, _asset(address(0), address(0), 6, 0));
        factory.setAsset(NVDA, _asset(NVDA_FEED, address(nvdaAverage), 18, 1));
        factory.setAsset(SPY, _asset(SPY_FEED, address(spyAverage), 18, 1));
        factory.setCashToken(USDG);
        factory.setRouter(UNIVERSAL_ROUTER, 2);
        vm.stopPrank();

        // $1,000 in the vault, 40% NVDA and 30% SPY as targets, auto-follow on.
        deal(USDG, owner, 1000e6);
        Weight[] memory targets = new Weight[](2);
        targets[0] = Weight(SPY, 3000);
        targets[1] = Weight(NVDA, 4000);
        vm.startPrank(owner);
        IErc20(USDG).approve(address(vault), 1000e6);
        vault.deposit(1000e6);
        vault.setTargets(targets);
        vault.setAutoFollow(true);
        vm.stopPrank();
    }

    function _asset(address feed_, address average, uint8 tokenDecimals, uint8 session)
        internal
        view
        returns (AssetConfig memory a)
    {
        a.tokenDecimals = tokenDecimals;
        if (feed_ == address(0)) return a;
        (uint256 price,) = _spot(feed_);
        a.feed = feed_;
        a.feedDecimals = 8;
        a.maxAge = 26 hours;
        a.session = session;
        a.source = 1;
        a.maxWeightBps = 5000;
        a.flags = 1;
        a.averageFeed = average;
        a.minPrice = uint128(price * 85 / 100);
        a.maxPrice = uint128(price * 115 / 100);
        // What `example.json` gives a stock token: `paused()` and `effectiveAt()` on the token itself.
        a.pauseProbe = feed_ == NVDA_FEED ? NVDA : SPY;
        a.pauseSelector = 0x5c975abb;
        a.scheduleSelector = 0x97a4064f;
    }

    /// The hookless 0.01% USDG/NVDA pool on Uniswap v4 that the owner's fork test trades through: the
    /// keeper trades there, and the v3 pool is only read.
    function _buyNvda(uint256 usdg) internal view returns (Swap memory) {
        (uint256 price,) = _spot(NVDA_FEED);
        uint256 minOut = usdg * 1e20 / price * 99 / 100;
        UniV4Calldata.PoolKey memory key = UniV4Calldata.PoolKey(USDG, NVDA, 100, 1, address(0));
        return Swap({
            router: UNIVERSAL_ROUTER,
            tokenIn: USDG,
            tokenOut: NVDA,
            amountIn: usdg,
            minOut: minOut,
            data: UniV4Calldata.exactInSingle(key, USDG, usdg, minOut, address(0), block.timestamp + 300)
        });
    }

    /// The pool's callback: pays what the swap in `_push` owes.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == NVDA_POOL, "not the pool");
        if (amount0Delta > 0) IErc20(USDG).transfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IErc20(NVDA).transfer(msg.sender, uint256(amount1Delta));
    }

    /// Buys NVDA in the v3 pool until it is 5% dearer there. Returns the dollars it took.
    function _push() internal returns (uint256 spent) {
        deal(USDG, address(this), 20_000_000e6);
        (int256 usdgIn,) = IV3Pool(NVDA_POOL).swap(address(this), true, int256(20_000_000e6), PUSHED, "");
        spent = uint256(usdgIn);
    }

    /// Sells the NVDA back until the pool is at `price` again. Returns the dollars that came back.
    function _putBack(uint160 price) internal returns (uint256 back) {
        (int256 usdgOut,) =
            IV3Pool(NVDA_POOL).swap(address(this), false, int256(IErc20(NVDA).balanceOf(address(this))), price, "");
        back = uint256(-usdgOut);
    }

    // ---- what the design could not confirm

    /// A contract reads `observe` on both pools and `latestRoundData` and `getRoundData` on both Chainlink
    /// proxies. The reads in the design were calls with no sender; these are calls from a contract.
    function test_fork_aContractReadsThePoolsAndTheChainlinkProxies() public onFork {
        assertEq(IV3Factory(V3_FACTORY).getPool(NVDA, USDG, 500), NVDA_POOL);
        assertEq(IV3Factory(V3_FACTORY).getPool(SPY, USDG, 500), SPY_POOL);
        uint32[] memory ago = new uint32[](2);
        ago[0] = WINDOW;
        (int56[] memory ticks,) = IV3Pool(NVDA_POOL).observe(ago);
        assertEq(int256(ticks[1]) - int256(ticks[0]), 798_990_269, "the NVDA pool's hour of ticks at this block");

        address[2] memory feeds = [NVDA_FEED, SPY_FEED];
        for (uint256 i; i < feeds.length; ++i) {
            (uint80 id, int256 answer,, uint256 updatedAt,) = IChainlink(feeds[i]).latestRoundData();
            assertGt(answer, 0);
            (, int256 before,, uint256 beforeAt,) = IChainlink(feeds[i]).getRoundData(id - 1);
            assertGt(before, 0);
            assertLt(beforeAt, updatedAt);
            console2.log(IChainlink(feeds[i]).description());
            console2.log("  latest answer, and its age in seconds:", uint256(answer), block.timestamp - updatedAt);
            console2.log("  the round before:", uint256(before));
        }
        assertEq(nvdaAverage.description(), "RHNVDA / USD (pool average)");
        assertEq(spyAverage.description(), "RHSPY / USD (pool average)");
    }

    /// The answer is `observe` worked off-chain at this block. NVDA: the hour's ticks sum to 798,990,269
    /// with USDG first, so the tick facing NVDA is -221,941.7, rounded down to -221,942, and
    /// 1.0001^-221942 * 10^20 is 22996583443. SPY: -755,088,324 with SPY first, -209,746.8, -209,747, and
    /// 77850061481 (`node script/tick-table.mjs`, exact integers).
    function test_fork_theAnswer_isObserveWorkedOffChain() public onFork {
        _log("NVDA", nvdaAverage);
        _log("SPY", spyAverage);
        (, int256 nvda,, uint256 stamp,) = nvdaAverage.latestRoundData();
        (, int256 spy,,,) = spyAverage.latestRoundData();
        assertEq(nvda, 22996583443);
        assertEq(spy, 77850061481);
        assertEq(stamp, block.timestamp);
        assertFalse(nvdaAverage.baseIsToken0());
        assertTrue(spyAverage.baseIsToken0());
    }

    /// Chainlink is within the band of where each token traded over the hour.
    function test_fork_chainlinkIsWithinTheBandOfThePoolAverage() public onFork {
        PoolAverageFeed[2] memory feeds = [nvdaAverage, spyAverage];
        for (uint256 i; i < feeds.length; ++i) {
            (uint256 average, uint256 spot,,,, PoolAverageFeed.Reason reason) = feeds[i].check();
            assertEq(uint8(reason), uint8(PoolAverageFeed.Reason.None));
            assertLe(_gapBps(spot, average), BAND);
        }
        // And against the pool's price at the block itself, for scale: the hour's average is near it.
        (, int24 tick,,,,,) = IV3Pool(NVDA_POOL).slot0();
        assertApproxEqAbs(int256(tick), 221_942, 100);
    }

    // ---- the keeper's leg

    /// A keeper leg lands: real feeds, the pool averages in the slot for both held targets, the real
    /// tokens' pause and schedule, the real router.
    function test_fork_keeperLeg_passes() public onFork {
        Swap memory s = _buyNvda(300e6);
        vm.prank(keeper);
        uint256 gasBefore = gasleft();
        (uint256 spent, uint256 received) = vault.keeperSwap(s);
        uint256 gasUsed = gasBefore - gasleft();
        assertEq(spent, 300e6);
        assertGe(received, s.minOut);
        console2.log("keeperSwap USDG -> NVDA with PoolAverageFeed in the average slot");
        console2.log("  NVDA received (18 decimals):", received);
        console2.log("  gas used by the call, two targets:", gasUsed);

        uint256 before = gasleft();
        nvdaAverage.latestRoundData();
        console2.log("  gas of one read of the pool average, warm:", before - gasleft());
    }

    /// The v3 pool is pushed 5% and put back in the next second, as anyone trading it back would do. While
    /// it sits at the pushed price the pool holds too little there and the keeper is refused. Once it is
    /// back the hour's average has not moved and the keeper's trade lands: a push of one block can stop the
    /// keeper for as long as it lasts, and changes nothing it accepts.
    function test_fork_keeperLeg_aPushOfOneBlock_changesNothing() public onFork {
        (uint256 before,,,,,) = nvdaAverage.check();
        (uint160 price,,,,,,) = IV3Pool(NVDA_POOL).slot0();
        uint256 spent = _push();
        (, int24 tick,,,,,) = IV3Pool(NVDA_POOL).slot0();
        console2.log("USDG it took to make NVDA 5% dearer in the v3 pool:", spent / 1e6);
        console2.log("  the pool's tick after:", int256(tick));
        console2.log("  the pool's liquidity in range there:", IV3Pool(NVDA_POOL).liquidity());
        (,,,,, PoolAverageFeed.Reason reason) = nvdaAverage.check();
        assertEq(uint8(reason), uint8(PoolAverageFeed.Reason.ThinPool), "thin at the pushed price");
        Swap memory s = _buyNvda(300e6);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.AssetNotPriced.selector, NVDA));
        vault.keeperSwap(s);

        vm.warp(block.timestamp + 1);
        uint256 back = _putBack(price);
        console2.log("  USDG lost to the pool's fee by pushing and putting back:", (spent - back) / 1e6);
        uint256 moved;
        (moved,,,,, reason) = nvdaAverage.check();
        assertEq(uint8(reason), uint8(PoolAverageFeed.Reason.None));
        assertLe(_gapBps(moved, before), 1, "one second of a 5% push is a seventh of a tick");
        vm.prank(keeper);
        vault.keeperSwap(s);
    }

    /// The pool is held 5% away for half an hour. With the floor it was deployed with, the feed gives no
    /// answer (the pool is thin at that price) and the keeper is refused. With a floor low enough to answer
    /// there, the average is over 2% from Chainlink and the keeper is refused by the vault's own distance
    /// check. Either way it is refused.
    function test_fork_keeperLeg_failsWhenThePoolIsPushedAway() public onFork {
        _push();
        vm.warp(block.timestamp + 30 minutes);
        Swap memory s = _buyNvda(300e6);
        (,,,,, PoolAverageFeed.Reason reason) = nvdaAverage.check();
        assertEq(uint8(reason), uint8(PoolAverageFeed.Reason.ThinPool));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.AssetNotPriced.selector, NVDA));
        vault.keeperSwap(s);

        PoolAverageFeed loose = new PoolAverageFeed(NVDA_POOL, NVDA, USDG, NVDA_FEED, 18, 6, WINDOW, 1, BAND, 12);
        AssetConfig memory a = factory.asset(NVDA);
        a.averageFeed = address(loose);
        vm.prank(admin);
        factory.setAsset(NVDA, a);
        uint256 average;
        uint256 spot;
        (average, spot,,,, reason) = loose.check();
        assertEq(uint8(reason), uint8(PoolAverageFeed.Reason.None));
        console2.log("after 30 minutes at the pushed price, gap in bps:", _gapBps(spot, average));
        assertGt(_gapBps(spot, average), BAND);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.PriceDeviation.selector, NVDA, spot, average));
        vault.keeperSwap(s);
    }

    /// The other held target stops the leg too: with SPY's pool feed refusing, NVDA is not traded.
    function test_fork_keeperLeg_failsWhenAnotherTargetsPoolFeedRefuses() public onFork {
        // The vault has to hold some SPY for it to be valued: the keeper buys NVDA first, then SPY's
        // average is replaced by one whose floor the pool does not meet.
        deal(SPY, address(vault), 0.1e18);
        PoolAverageFeed strict =
            new PoolAverageFeed(SPY_POOL, SPY, USDG, SPY_FEED, 18, 6, WINDOW, type(uint128).max, BAND, 12);
        AssetConfig memory a = factory.asset(SPY);
        a.averageFeed = address(strict);
        vm.prank(admin);
        factory.setAsset(SPY, a);
        Swap memory s = _buyNvda(300e6);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.AssetNotPriced.selector, SPY));
        vault.keeperSwap(s);
    }
}

/// Friday 2026-10-09 at 15:19:16 UTC: ten minutes after NVDA's Chainlink feed wrote a round 52 bps under
/// the one before. The feed's own average needs the round before, read through the proxy by a contract.
contract RobinhoodForkPoolFeedAfterARoundTest is RobinhoodForkPoolFeedBase {
    function _block() internal pure override returns (uint256) {
        return 84_256_938;
    }

    function test_fork_aRoundInsideTheHour_isWeighedThroughTheProxy() public onFork {
        _log("NVDA, ten minutes after a round", nvdaAverage);
        (uint256 latest, uint256 latestAt) = _spot(NVDA_FEED);
        assertEq(block.timestamp - latestAt, 600);
        (uint256 average, uint256 spot, uint256 own,,, PoolAverageFeed.Reason reason) = nvdaAverage.check();
        assertEq(uint8(reason), uint8(PoolAverageFeed.Reason.None));
        assertEq(spot, latest);
        // 600 seconds at 230.36242923 and 3,000 at the 231.57436794 before it.
        assertEq(own, (uint256(23036242923) * 600 + uint256(23157436794) * 3000) / 3600);
        // -221,896.6 facing NVDA, rounded down to -221,897.
        assertEq(average, 23100296061);
        assertLe(_gapBps(spot, average), BAND);
    }
}
