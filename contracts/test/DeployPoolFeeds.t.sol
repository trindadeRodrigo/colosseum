// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {DeployPoolFeeds} from "../script/DeployPoolFeeds.s.sol";
import {PoolAverageFeed} from "../src/price/PoolAverageFeed.sol";
import {MockRoundFeed} from "./mocks/Feeds.sol";
import {MockV3Pool} from "./mocks/Pools.sol";
import {MockToken} from "./mocks/Tokens.sol";

/// A v3 factory that names one pool per pair and fee.
contract MockPoolFactory {
    mapping(bytes32 => address) internal pools;

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
        cfg.quoteToken = address(dollar);
        cfg.quoteDecimals = 6;
        cfg.window = 3600;
        cfg.maxRounds = 12;
        cfg.assets = new DeployPoolFeeds.Asset[](assets);
    }

    /// An asset with a pool the factory names, at `liquidity`, and a floor of half the usual.
    function _asset(string memory symbol, uint128 liquidity) internal returns (DeployPoolFeeds.Asset memory a) {
        MockToken token = new MockToken(18);
        MockV3Pool pool = new MockV3Pool(address(dollar), address(token), 230_270, liquidity);
        poolFactory.set(address(token), address(dollar), 500, address(pool));
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

    /// A person's word in the file lifts a hold, and the floor at deployment too.
    function test_accepted_liftsAHold() public {
        DeployPoolFeeds.Config memory cfg = _config(2);
        cfg.assets[0] = _asset("GOLD", LIQUIDITY);
        _held(cfg.assets[0], "feed-from-pools");
        cfg.assets[0].accepted = true;
        cfg.assets[1] = _asset("THIN", 1);
        cfg.assets[1].accepted = true;
        DeployPoolFeeds.Outcome[] memory out = script.deploy(cfg);
        assertTrue(out[0].averageFeed != address(0));
        assertTrue(out[1].averageFeed != address(0));
        // A feed over a pool under its floor gives no answer: accepting it deploys it, it does not price it.
        vm.warp(block.timestamp + 1 hours);
        (,,,,, PoolAverageFeed.Reason reason) = PoolAverageFeed(out[1].averageFeed).check();
        assertEq(uint8(reason), uint8(PoolAverageFeed.Reason.ThinPool));
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
        cfg.assets[0].pool = other;
        vm.expectRevert(abi.encodeWithSelector(DeployPoolFeeds.NotTheFactorysPool.selector, "AAA", other, real));
        script.deploy(cfg);
        cfg.assets[0].pool = real;
        cfg.assets[0].fee = 3000;
        vm.expectRevert(abi.encodeWithSelector(DeployPoolFeeds.NotTheFactorysPool.selector, "AAA", real, address(0)));
        script.deploy(cfg);
        cfg.assets[0].fee = 500;

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

        // With every hold accepted, each of the eleven can be deployed and read: the mechanics hold for
        // all of them, and what each answers at this block is printed.
        for (uint256 i; i < cfg.assets.length; ++i) {
            cfg.assets[i].accepted = true;
        }
        out = script.deploy(cfg);
        for (uint256 i; i < out.length; ++i) {
            (uint256 average, uint256 spot,, uint128 liquidity, uint128 mean, PoolAverageFeed.Reason reason) =
                PoolAverageFeed(out[i].averageFeed).check();
            console2.log(out[i].symbol);
            console2.log("  pool average, Chainlink:", average, spot);
            console2.log("  gap in bps:", (average > spot ? average - spot : spot - average) * 10_000 / average);
            console2.log("  liquidity now, the hour's average:", liquidity, mean);
            console2.log("  reason (0 is none):", uint8(reason));
        }
    }
}
