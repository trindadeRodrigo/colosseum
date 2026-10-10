// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {PoolAverageFeed} from "../src/price/PoolAverageFeed.sol";

interface IPoolFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IPoolLiquidity {
    function liquidity() external view returns (uint128);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

interface IFeedDescription {
    function description() external view returns (string memory);
}

/// Deploys one `PoolAverageFeed` per asset of a chain, from `script/config/pool-feeds/<chain id>.json` or
/// the file `POOL_FEEDS_CONFIG` names, and prints each address: the `averageFeed` of that asset in the
/// chain's main file (`script/config/<chain id>.json`), which `Deploy.s.sol` then writes with `setAsset`.
/// This script touches nothing of the vault's: the feeds have no owner and depend on nothing of ours, so
/// they are deployed first and their addresses copied across by a person.
///
///   forge script script/DeployPoolFeeds.s.sol --rpc-url <url> --sender <deployer>
///
/// That is a dry run: it simulates against the chain the URL answers for and prints what it would deploy
/// and what it refuses. Sending is `--broadcast`, and a person does that, never an agent.
///
/// What it refuses, asset by asset, and deploys the rest:
///   - an asset whose pool keeps no more observations than the window has seconds. Anyone may grow a
///     pool's history first, and a person sends it: `increaseObservationCardinalityNext(7200)` on the pool,
///     for example `cast send <pool> "increaseObservationCardinalityNext(uint16)" 7200`. The new slots
///     count once the pool has written its way into them, which takes as many trades as it has slots now;
///   - an asset whose pool holds less in range than the file's floor at the moment it runs;
///   - an asset the file marks with a hold (`holds`): the reasons the design keeps it owner-signed, such as
///     a Chainlink feed that is itself made from pools, or a feed whose round history nobody has read.
/// Only a hold is lifted by `accepted: true` in the file, which a person sets after deciding. The other
/// two are the pool's own state and nothing in the file lifts them.
///
/// What stops the whole run, because the file is then wrong: another chain, a pool that is not the one the
/// v3 factory names for the pair and the fee, a pool that is not Uniswap's own code, and a feed that does
/// not describe itself as the file says.
///
/// Uniswap's own code: a v3 pool's deployed code carries its two tokens, its fee and its factory, so no two
/// pools have the same code hash. What every pool of a factory shares is the code that created it. The
/// factory creates a pool at the address CREATE2 gives for its own address, the pair and fee, and the hash
/// of that creation code; the file states the hash (`poolInitCodeHash`, Uniswap v3's published one), and a
/// pool whose address is not the one it gives was not made from that code.
contract DeployPoolFeeds is Script {
    using stdJson for string;

    struct Asset {
        string symbol;
        address token;
        uint8 tokenDecimals;
        address feed;
        string feedDescription;
        address pool;
        uint24 fee;
        uint128 minLiquidity;
        uint16 jumpBps;
        string[] holds;
        bool accepted;
    }

    struct Config {
        uint256 chainId;
        address v3Factory;
        bytes32 poolInitCodeHash;
        address quoteToken;
        uint8 quoteDecimals;
        uint32 window;
        uint8 maxRounds;
        Asset[] assets;
    }

    /// What became of one asset: the feed deployed for it, or why none was.
    struct Outcome {
        string symbol;
        address token;
        address averageFeed;
        string refused;
    }

    error WrongChain(uint256 configIsFor, uint256 runningOn);
    error NotTheFactorysPool(string symbol, address inTheFile, address factorySays);
    error NotTheFeedDescribed(string symbol, string inTheFile, string feedSays);
    error NotUniswapsPoolCode(string symbol, address pool, address fromTheInitCode);
    error ValueDoesNotFit(string key, uint256 value, uint256 most);

    function run() external returns (Outcome[] memory out) {
        Config memory cfg = readConfig(_path());
        vm.startBroadcast();
        out = deploy(cfg);
        vm.stopBroadcast();
        _print(cfg, out);
    }

    /// Checks every asset of the file against the chain, then deploys a feed for each that is not refused.
    function deploy(Config memory cfg) public returns (Outcome[] memory out) {
        require(cfg.chainId == block.chainid, WrongChain(cfg.chainId, block.chainid));
        out = new Outcome[](cfg.assets.length);
        for (uint256 i; i < cfg.assets.length; ++i) {
            Asset memory a = cfg.assets[i];
            out[i].symbol = a.symbol;
            out[i].token = a.token;
            out[i].refused = refusal(cfg, a);
            if (bytes(out[i].refused).length != 0) continue;
            out[i].averageFeed = address(
                new PoolAverageFeed(
                    a.pool,
                    a.token,
                    cfg.quoteToken,
                    a.feed,
                    a.tokenDecimals,
                    cfg.quoteDecimals,
                    cfg.window,
                    a.minLiquidity,
                    a.jumpBps,
                    cfg.maxRounds
                )
            );
        }
    }

    /// Why no feed is deployed for `a`, or nothing when one is. Reverts when the file is wrong about the
    /// pool or the feed, whatever `accepted` says.
    function refusal(Config memory cfg, Asset memory a) public view returns (string memory) {
        address named = IPoolFactory(cfg.v3Factory).getPool(a.token, cfg.quoteToken, a.fee);
        require(named == a.pool, NotTheFactorysPool(a.symbol, a.pool, named));
        if (a.feed != address(0)) {
            string memory says = IFeedDescription(a.feed).description();
            require(
                keccak256(bytes(says)) == keccak256(bytes(a.feedDescription)),
                NotTheFeedDescribed(a.symbol, a.feedDescription, says)
            );
        }
        if (a.pool == address(0)) return "no v3 pool against the dollar token";
        address made = poolAddress(cfg, a);
        require(made == a.pool, NotUniswapsPoolCode(a.symbol, a.pool, made));
        if (!a.accepted && a.holds.length != 0) return string.concat("held: ", a.holds[0]);
        (,,, uint16 cardinality,,,) = IPoolLiquidity(a.pool).slot0();
        if (cardinality <= cfg.window) {
            return string.concat(
                "the pool keeps ",
                vm.toString(uint256(cardinality)),
                " observations and the window needs more than ",
                vm.toString(uint256(cfg.window)),
                ": grow it first with increaseObservationCardinalityNext"
            );
        }
        uint128 inRange = IPoolLiquidity(a.pool).liquidity();
        if (inRange < a.minLiquidity) {
            return string.concat(
                "the pool holds ",
                vm.toString(uint256(inRange)),
                " in range, under the floor of ",
                vm.toString(uint256(a.minLiquidity))
            );
        }
        return "";
    }

    /// Where the factory's CREATE2 puts the pool of this pair and fee, made from the creation code whose
    /// hash the file states.
    function poolAddress(Config memory cfg, Asset memory a) public pure returns (address) {
        (address token0, address token1) =
            a.token < cfg.quoteToken ? (a.token, cfg.quoteToken) : (cfg.quoteToken, a.token);
        bytes32 salt = keccak256(abi.encode(token0, token1, a.fee));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), cfg.v3Factory, salt, cfg.poolInitCodeHash))))
        );
    }

    function readConfig(string memory path) public view returns (Config memory cfg) {
        return parseConfig(vm.readFile(path));
    }

    function parseConfig(string memory json) public view returns (Config memory cfg) {
        cfg.chainId = json.readUint(".chainId");
        cfg.v3Factory = json.readAddress(".v3Factory");
        cfg.poolInitCodeHash = json.readBytes32(".poolInitCodeHash");
        cfg.quoteToken = json.readAddress(".quoteToken");
        cfg.quoteDecimals = uint8(_fit(json, ".quoteDecimals", type(uint8).max));
        cfg.window = uint32(_fit(json, ".window", type(uint32).max));
        cfg.maxRounds = uint8(_fit(json, ".maxRounds", type(uint8).max));

        uint256 n = _count(json, ".assets");
        cfg.assets = new Asset[](n);
        for (uint256 i; i < n; ++i) {
            string memory entry = string.concat(".assets[", vm.toString(i), "]");
            Asset memory a = cfg.assets[i];
            a.symbol = json.readString(string.concat(entry, ".symbol"));
            a.token = json.readAddress(string.concat(entry, ".token"));
            a.tokenDecimals = uint8(_fit(json, string.concat(entry, ".tokenDecimals"), type(uint8).max));
            a.feed = json.readAddress(string.concat(entry, ".feed"));
            a.feedDescription = json.readString(string.concat(entry, ".feedDescription"));
            a.pool = json.readAddress(string.concat(entry, ".pool"));
            a.fee = uint24(_fit(json, string.concat(entry, ".fee"), type(uint24).max));
            // A decimal string: a pool's liquidity is more than a JSON number holds exactly.
            string memory floorKey = string.concat(entry, ".minLiquidity");
            uint256 floor = vm.parseUint(json.readString(floorKey));
            require(floor <= type(uint128).max, ValueDoesNotFit(floorKey, floor, type(uint128).max));
            a.minLiquidity = uint128(floor);
            a.jumpBps = uint16(_fit(json, string.concat(entry, ".jumpBps"), type(uint16).max));
            a.accepted = json.readBool(string.concat(entry, ".accepted"));
            uint256 holds = _count(json, string.concat(entry, ".holds"));
            a.holds = new string[](holds);
            for (uint256 j; j < holds; ++j) {
                a.holds[j] = json.readString(string.concat(entry, ".holds[", vm.toString(j), "]"));
            }
        }
    }

    function _path() private view returns (string memory) {
        return vm.envOr(
            "POOL_FEEDS_CONFIG", string.concat("script/config/pool-feeds/", vm.toString(block.chainid), ".json")
        );
    }

    function _count(string memory json, string memory list) private view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(list, "[", vm.toString(n), "]"))) ++n;
    }

    function _fit(string memory json, string memory key, uint256 most) private pure returns (uint256 value) {
        value = json.readUint(key);
        require(value <= most, ValueDoesNotFit(key, value, most));
    }

    function _print(Config memory cfg, Outcome[] memory out) private view {
        console2.log("chain id:", block.chainid);
        console2.log("window, seconds:", uint256(cfg.window));
        uint256 deployed;
        for (uint256 i; i < out.length; ++i) {
            if (out[i].averageFeed == address(0)) {
                console2.log(string.concat(out[i].symbol, ": no feed deployed, ", out[i].refused));
                continue;
            }
            ++deployed;
            (uint256 average, uint256 spot,,,, PoolAverageFeed.Reason reason) =
                PoolAverageFeed(out[i].averageFeed).check();
            console2.log(
                string.concat(out[i].symbol, ": averageFeed for token ", vm.toString(out[i].token), " is"),
                out[i].averageFeed
            );
            console2.log("    pool average, Chainlink, reason now (0 is none):", average, spot, uint8(reason));
        }
        console2.log("feeds deployed:", deployed);
        console2.log("refused:", out.length - deployed);
        console2.log("next, by a person: each address above into that asset's averageFeed in the chain's main file");
    }
}
