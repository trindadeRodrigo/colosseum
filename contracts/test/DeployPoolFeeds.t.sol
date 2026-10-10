// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {DeployPoolFeeds} from "../script/DeployPoolFeeds.s.sol";
import {PoolAverageFeed} from "../src/price/PoolAverageFeed.sol";
import {MockRoundFeed} from "./mocks/Feeds.sol";
import {MockV3Pool} from "./mocks/Pools.sol";
import {MockToken} from "./mocks/Tokens.sol";

/// A v3 factory as Uniswap's makes pools: at the CREATE2 address of the pair and the fee, from one creation
/// code that takes no argument and reads what it is from the factory.
contract MockPoolFactory {
    mapping(bytes32 => address) internal pools;
    address public token0;
    address public token1;
    int24 public tick;
    uint128 public liquidity;

    function create(address a, address b, uint24 fee, int24 tick_, uint128 liquidity_)
        external
        returns (address pool)
    {
        (token0, token1) = a < b ? (a, b) : (b, a);
        tick = tick_;
        liquidity = liquidity_;
        pool = address(new FactoryMadePool{salt: keccak256(abi.encode(token0, token1, fee))}());
        pools[_key(a, b, fee)] = pool;
    }

    function set(address a, address b, uint24 fee, address pool) external {
        pools[_key(a, b, fee)] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return pools[_key(a, b, fee)];
    }

    function _key(address a, address b, uint24 fee) private pure returns (bytes32) {
        (address low, address high) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encode(low, high, fee));
    }
}

contract FactoryMadePool is MockV3Pool {
    constructor()
        MockV3Pool(
            MockPoolFactory(msg.sender).token0(),
            MockPoolFactory(msg.sender).token1(),
            MockPoolFactory(msg.sender).tick(),
            MockPoolFactory(msg.sender).liquidity()
        )
    {}
}

/// The script that deploys the pool-average feeds, run inside a test: what it deploys, what it refuses and
/// what stops it. Nothing here reaches a network.
contract DeployPoolFeedsTest is Test {
    uint128 internal constant LIQUIDITY = 7e18;

    DeployPoolFeeds internal script;
    MockPoolFactory internal poolFactory;
    MockToken internal dollar;
    MockRoundFeed internal chainlink;

    function setUp() public {
        vm.warp(1_791_212_400);
        script = new DeployPoolFeeds();
        poolFactory = new MockPoolFactory();
        dollar = new MockToken(6);
        chainlink = new MockRoundFeed();
        chainlink.push(100e8, block.timestamp - 2 hours);
    }

    function _config(uint256 assets) internal view returns (DeployPoolFeeds.Config memory cfg) {
        cfg.chainId = block.chainid;
        cfg.v3Factory = address(poolFactory);
        cfg.poolInitCodeHash = keccak256(type(FactoryMadePool).creationCode);
        cfg.quoteToken = address(dollar);
        cfg.quoteDecimals = 6;
        cfg.window = 3600;
        cfg.maxRounds = 12;
        cfg.assets = new DeployPoolFeeds.Asset[](assets);
    }

    /// An asset with a pool the factory names, at `liquidity`, and a floor of half the usual.
    function _asset(string memory symbol, uint128 liquidity) internal returns (DeployPoolFeeds.Asset memory a) {
        MockToken token = new MockToken(18);
        // $100.0002 for the token, whichever of the two comes first in the pool.
        int24 tick = address(dollar) < address(token) ? int24(230_270) : int24(-230_270);
        MockV3Pool pool = MockV3Pool(poolFactory.create(address(token), address(dollar), 500, tick, liquidity));
        a.symbol = symbol;
        a.token = address(token);
        a.tokenDecimals = 18;
        a.feed = address(chainlink);
        a.feedDescription = "TEST / USD";
        a.pool = address(pool);
        a.fee = 500;
        a.minLiquidity = LIQUIDITY / 2;
        a.jumpBps = 150;
    }

    function _held(DeployPoolFeeds.Asset memory a, string memory why) internal pure {
        a.holds = new string[](1);
        a.holds[0] = why;
    }

    function test_deploys_oneFeedPerAsset_andRefusesTheHeld() public {
        DeployPoolFeeds.Config memory cfg = _config(4);
        cfg.assets[0] = _asset("AAA", LIQUIDITY);
        cfg.assets[1] = _asset("GOLD", LIQUIDITY);
        _held(cfg.assets[1], "feed-from-pools");
        cfg.assets[2] = _asset("THIN", LIQUIDITY / 2 - 1);
        cfg.assets[3] = _asset("UNREAD", LIQUIDITY);
        _held(cfg.assets[3], "rounds-unread");
        vm.warp(block.timestamp + 1 hours);

        DeployPoolFeeds.Outcome[] memory out = script.deploy(cfg);
        assertEq(out.length, 4);

        PoolAverageFeed feed = PoolAverageFeed(out[0].averageFeed);
        assertEq(out[0].refused, "");
        assertEq(feed.pool(), cfg.assets[0].pool);
        assertEq(feed.base(), cfg.assets[0].token);
        assertEq(feed.quote(), address(dollar));
        assertEq(feed.feed(), address(chainlink));
        assertEq(feed.window(), 3600);
        assertEq(feed.minLiquidity(), LIQUIDITY / 2);
        assertEq(feed.jumpBps(), 150);
        assertEq(feed.maxRounds(), 12);
        (, int256 answer,,,) = feed.latestRoundData();
        assertEq(answer, 10000022031);

        assertEq(out[1].averageFeed, address(0));
        assertEq(out[1].refused, "held: feed-from-pools");
        assertEq(out[2].averageFeed, address(0));
        assertEq(out[2].refused, "the pool holds 3499999999999999999 in range, under the floor of 3500000000000000000");
        assertEq(out[3].averageFeed, address(0));
        assertEq(out[3].refused, "held: rounds-unread");
    }

    /// A person's word in the file lifts a hold and nothing else: a pool under its floor, or one that keeps
    /// too few observations for the window, is refused all the same.
    function test_accepted_liftsAHold_andNothingElse() public {
        DeployPoolFeeds.Config memory cfg = _config(4);
        cfg.assets[0] = _asset("GOLD", LIQUIDITY);
        _held(cfg.assets[0], "feed-from-pools");
        cfg.assets[0].accepted = true;
        cfg.assets[1] = _asset("THIN", 1);
        cfg.assets[1].accepted = true;
        cfg.assets[2] = _asset("SHORT", LIQUIDITY);
        cfg.assets[2].accepted = true;
        MockV3Pool(cfg.assets[2].pool).setCardinality(1801);
        // At one more slot than the window has seconds it is enough.
        cfg.assets[3] = _asset("ENOUGH", LIQUIDITY);
        MockV3Pool(cfg.assets[3].pool).setCardinality(3601);
        DeployPoolFeeds.Outcome[] memory out = script.deploy(cfg);
        assertTrue(out[0].averageFeed != address(0));
        assertEq(out[1].averageFeed, address(0));
        assertEq(out[1].refused, "the pool holds 1 in range, under the floor of 3500000000000000000");
        assertEq(out[2].averageFeed, address(0));
        assertEq(
            out[2].refused,
            "the pool keeps 1801 observations and the window needs more than 3600: grow it first with increaseObservationCardinalityNext"
        );
        assertTrue(out[3].averageFeed != address(0));
    }

    function test_anAssetWithNoPool_isRefused() public {
        DeployPoolFeeds.Config memory cfg = _config(1);
        cfg.assets[0] = _asset("NONE", LIQUIDITY);
        poolFactory.set(cfg.assets[0].token, address(dollar), 500, address(0));
        cfg.assets[0].pool = address(0);
        DeployPoolFeeds.Outcome[] memory out = script.deploy(cfg);
        assertEq(out[0].averageFeed, address(0));
        assertEq(out[0].refused, "no v3 pool against the dollar token");
    }

    /// A file that is wrong stops the run, accepted or not.
    function test_aWrongFile_stopsTheRun() public {
        DeployPoolFeeds.Config memory cfg = _config(1);
        cfg.assets[0] = _asset("AAA", LIQUIDITY);
        cfg.assets[0].accepted = true;

        cfg.chainId = 4663;
        vm.expectRevert(abi.encodeWithSelector(DeployPoolFeeds.WrongChain.selector, 4663, block.chainid));
        script.deploy(cfg);
        cfg.chainId = block.chainid;

        // A pool the factory does not name for the pair and the fee.
        address real = cfg.assets[0].pool;
        address other = address(new MockV3Pool(address(dollar), cfg.assets[0].token, 230_270, LIQUIDITY));
        assertEq(script.poolAddress(cfg, cfg.assets[0]), real, "the factory's CREATE2 address is the pool");
        cfg.assets[0].pool = other;
        vm.expectRevert(abi.encodeWithSelector(DeployPoolFeeds.NotTheFactorysPool.selector, "AAA", other, real));
        script.deploy(cfg);
        cfg.assets[0].pool = real;
        cfg.assets[0].fee = 3000;
        vm.expectRevert(abi.encodeWithSelector(DeployPoolFeeds.NotTheFactorysPool.selector, "AAA", real, address(0)));
        script.deploy(cfg);
        cfg.assets[0].fee = 500;

        // A pool the factory names that was not made from the creation code the file states: the factory
        // is told of a pool deployed some other way.
        poolFactory.set(cfg.assets[0].token, address(dollar), 500, other);
        cfg.assets[0].pool = other;
        vm.expectRevert(abi.encodeWithSelector(DeployPoolFeeds.NotUniswapsPoolCode.selector, "AAA", other, real));
        script.deploy(cfg);
        poolFactory.set(cfg.assets[0].token, address(dollar), 500, real);
        cfg.assets[0].pool = real;
        // Or the file states another hash.
        cfg.poolInitCodeHash = keccak256("other code");
        address elsewhere = script.poolAddress(cfg, cfg.assets[0]);
        vm.expectRevert(abi.encodeWithSelector(DeployPoolFeeds.NotUniswapsPoolCode.selector, "AAA", real, elsewhere));
        script.deploy(cfg);
        cfg.poolInitCodeHash = keccak256(type(FactoryMadePool).creationCode);

        // A feed that says it prices something else.
        cfg.assets[0].feedDescription = "OTHER / USD";
        vm.expectRevert(
            abi.encodeWithSelector(DeployPoolFeeds.NotTheFeedDescribed.selector, "AAA", "OTHER / USD", "TEST / USD")
        );
        script.deploy(cfg);
    }

    /// The mainnet file as committed: eleven assets, and a hold on each one the design keeps owner-signed.
    /// Nobody has accepted any.
    function test_theMainnetFile_holdsWhatTheDesignKeepsOwnerSigned() public view {
        DeployPoolFeeds.Config memory cfg = script.readConfig("script/config/pool-feeds/4663.json");
        assertEq(cfg.chainId, 4663);
        assertEq(cfg.quoteToken, 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
        // Uniswap v3's published pool creation code hash (v3-periphery's `POOL_INIT_CODE_HASH`).
        assertEq(cfg.poolInitCodeHash, 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54);
        assertEq(cfg.quoteDecimals, 6);
        assertEq(cfg.window, 3600);
        assertEq(cfg.maxRounds, 12);
        assertEq(cfg.assets.length, 11);
        uint256 clear;
        for (uint256 i; i < cfg.assets.length; ++i) {
            DeployPoolFeeds.Asset memory a = cfg.assets[i];
            assertFalse(a.accepted, a.symbol);
            assertEq(a.jumpBps, 150, a.symbol);
            assertEq(a.tokenDecimals, 18, a.symbol);
            assertGt(a.minLiquidity, 0, a.symbol);
            assertTrue(a.fee == 500 || a.fee == 3000, a.symbol);
            bytes32 symbol = keccak256(bytes(a.symbol));
            if (symbol == keccak256("NVDA") || symbol == keccak256("SPY") || symbol == keccak256("MSFT")) {
                assertEq(a.holds.length, 0, a.symbol);
                ++clear;
                continue;
            }
            assertEq(a.holds.length, 1, a.symbol);
            string memory expected = symbol == keccak256("GLD")
                ? "feed-from-pools"
                : symbol == keccak256("SGOV") ? "person-decides" : "rounds-unread";
            assertEq(a.holds[0], expected, a.symbol);
        }
        assertEq(clear, 3);
    }

    /// The whole script against Robinhood Chain as it was on Friday 2026-10-09 at 16:30 UTC, from the
    /// committed file: the factory names every pool in it, every feed describes itself as written, three
    /// feeds are deployed and answer, and eight assets are refused. Skipped without `RH_FORK_URL`.
    function test_fork_theMainnetFile_dryRun() public {
        string memory url = vm.envOr("RH_FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url, 84_298_619);
        script = new DeployPoolFeeds();
        DeployPoolFeeds.Config memory cfg = script.readConfig("script/config/pool-feeds/4663.json");
        DeployPoolFeeds.Outcome[] memory out = script.deploy(cfg);
        uint256 deployed;
        for (uint256 i; i < out.length; ++i) {
            if (out[i].averageFeed == address(0)) {
                console2.log(string.concat(out[i].symbol, ": refused, ", out[i].refused));
                continue;
            }
            ++deployed;
            (uint256 average, uint256 spot,,,, PoolAverageFeed.Reason reason) =
                PoolAverageFeed(out[i].averageFeed).check();
            console2.log(
                string.concat(out[i].symbol, ": pool average, Chainlink, reason"), average, spot, uint8(reason)
            );
            assertEq(uint8(reason), uint8(PoolAverageFeed.Reason.None), out[i].symbol);
        }
        assertEq(deployed, 3);

        // With every hold accepted: the eight pools that keep 7,200 observations are deployed and read,
        // and META, SGOV and GLD, which keep about 1,800, are still refused until someone grows them.
        // Every one of the eleven pools sits at the address Uniswap's creation code gives (or the run
        // would have stopped).
        for (uint256 i; i < cfg.assets.length; ++i) {
            cfg.assets[i].accepted = true;
        }
        out = script.deploy(cfg);
        deployed = 0;
        for (uint256 i; i < out.length; ++i) {
            console2.log(out[i].symbol);
            if (out[i].averageFeed == address(0)) {
                console2.log(string.concat("  refused, ", out[i].refused));
                bytes32 symbol = keccak256(bytes(out[i].symbol));
                assertTrue(
                    symbol == keccak256("META") || symbol == keccak256("SGOV") || symbol == keccak256("GLD"),
                    out[i].symbol
                );
                continue;
            }
            ++deployed;
            (uint256 average, uint256 spot,, uint128 liquidity, uint128 mean, PoolAverageFeed.Reason reason) =
                PoolAverageFeed(out[i].averageFeed).check();
            console2.log("  pool average, Chainlink:", average, spot);
            console2.log("  gap in bps:", (average > spot ? average - spot : spot - average) * 10_000 / average);
            console2.log("  liquidity now, the hour's average:", liquidity, mean);
            console2.log("  reason (0 is none):", uint8(reason));
        }
        assertEq(deployed, 8);
    }
}
