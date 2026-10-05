// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {AssetConfig} from "../../src/interfaces/Types.sol";
import {TestMarket} from "../../testnet/TestMarket.sol";
import {TestPriceFeed} from "../../testnet/TestPriceFeed.sol";
import {TestStockToken} from "../../testnet/TestStockToken.sol";
import {TestToken} from "../../testnet/TestToken.sol";

/// TEST NETWORK ONLY. Sets up an EVM test network for the vault (TNET-1, TNET-2): the test cash, a test
/// stock token per entry of the file with its price contract and its average, Universal Router 2.1.2, and
/// the test market with one Uniswap v4 pool per token against the test cash, opened at the token's test
/// price and seeded over the whole range. Everything comes from `script/testnet/config/<chain id>.json`, or
/// the file `TESTNET_CONFIG` names.
///
///   forge script script/testnet/TestnetKit.s.sol --rpc-url <url> --sender <deployer>
///
/// That is a dry run: it simulates against the chain the URL answers for and prints every transaction it
/// would send, numbered. Sending is `--broadcast`, and a person does that, never an agent.
///
/// Each contract goes through the CREATE2 deployer with a salt from the file and its name, so its address
/// follows from the file and the deployer. Each step looks at the chain first and is left out when it is
/// done: a contract that has code, a role already held, a writer already named, a feed with a round, a pool
/// already open, a pool with liquidity. A second run sends nothing.
///
/// The deployer is the admin of every contract here. The price writer the file names writes the price
/// contracts and re-centres the pools; it is never the deployer.
///
/// With `TESTNET_RECORD` set to a path, the run writes there what it deployed: the record the price copier,
/// `scripts/testnet/robinhood/vault-config.mjs` and the app read.
contract TestnetKit is Script {
    using stdJson for string;

    /// The deterministic deployer at the same address on every chain the kit runs on.
    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes4 internal constant PAUSED = bytes4(keccak256("paused()"));
    bytes4 internal constant EFFECTIVE_AT = bytes4(keccak256("effectiveAt()"));

    struct Token {
        string symbol;
        string name;
        string modelOf;
        uint8 decimals;
        /// The mainnet feed the copier copies, and what it says of itself.
        address source;
        string sourceDescription;
        uint8 feedDecimals;
        /// The round the kit writes first.
        int256 answer;
        uint256 updatedAt;
    }

    /// Universal Router's constructor, in the order of its `RouterParameters`; Permit2 and the PoolManager
    /// come from `Config`.
    struct Router {
        address weth9;
        address v2Factory;
        address v3Factory;
        bytes32 pairInitCodeHash;
        bytes32 poolInitCodeHash;
        address v3NFTPositionManager;
        address v4PositionManager;
        address spokePool;
        bytes creationCode;
    }

    struct Config {
        uint256 chainId;
        string salt;
        address priceWriter;
        string cashSymbol;
        string cashName;
        string cashModelOf;
        uint8 cashDecimals;
        address poolManager;
        address permit2;
        uint24 fee;
        int24 tickSpacing;
        uint16 driftBps;
        uint256 cashPerSide;
        Router router;
        Token[] tokens;
    }

    struct Listed {
        address token;
        address feed;
        address average;
        bytes32 poolId;
    }

    struct Deployed {
        address admin;
        address cash;
        address router;
        address market;
        Listed[] tokens;
    }

    error WrongChain(uint256 configIsFor, uint256 runningOn);
    error NoPriceWriter();
    error WriterIsDeployer(address writer);
    error NoCreate2Deployer();
    error CreateFailed(string name, address expected);
    error ValueDoesNotFit(string key, uint256 value, uint256 most);

    /// Transactions printed so far in this run.
    uint256 public sent;

    function run() external returns (Deployed memory d) {
        Config memory cfg = readConfig(_path());
        vm.startBroadcast();
        d = deploy(cfg, msg.sender);
        vm.stopBroadcast();
        _print(cfg, d);
        string memory record = vm.envOr("TESTNET_RECORD", string(""));
        if (bytes(record).length != 0) {
            vm.writeJson(recordJson(cfg, d), record);
            console2.log("record written:", record);
        }
    }

    /// Deploys and sets up what is missing, as `deployer`: the address the calls below come from.
    function deploy(Config memory cfg, address deployer) public returns (Deployed memory d) {
        require(cfg.chainId == block.chainid, WrongChain(cfg.chainId, block.chainid));
        require(cfg.priceWriter != address(0), NoPriceWriter());
        require(cfg.priceWriter != deployer, WriterIsDeployer(cfg.priceWriter));
        require(CREATE2_DEPLOYER.code.length != 0, NoCreate2Deployer());
        d.admin = deployer;

        d.cash = _create(
            cfg,
            string.concat("cash/", cfg.cashSymbol),
            abi.encodePacked(
                type(TestToken).creationCode, abi.encode(cfg.cashName, cfg.cashSymbol, cfg.cashDecimals, deployer)
            )
        );
        d.router = _create(cfg, "universal-router-2.1.2", abi.encodePacked(cfg.router.creationCode, routerArgs(cfg)));
        d.market = _create(
            cfg,
            "market",
            abi.encodePacked(
                type(TestMarket).creationCode,
                abi.encode(deployer, cfg.poolManager, d.cash, cfg.fee, cfg.tickSpacing, cfg.driftBps)
            )
        );
        d.tokens = new Listed[](cfg.tokens.length);
        for (uint256 i; i < cfg.tokens.length; ++i) {
            Token memory t = cfg.tokens[i];
            d.tokens[i].token = _create(
                cfg,
                string.concat("token/", t.symbol),
                abi.encodePacked(type(TestStockToken).creationCode, abi.encode(t.name, t.symbol, t.decimals, deployer))
            );
            d.tokens[i].feed = _create(cfg, string.concat("feed/", t.symbol), _feedCode(t, deployer, false));
            d.tokens[i].average = _create(cfg, string.concat("average/", t.symbol), _feedCode(t, deployer, true));
        }

        // The market mints what its pools are owed, so it holds the minter role on every token; the deployer
        // holds the issuer's role on the stock tokens, to pause one or change its multiplier in a test.
        _grant(d.cash, TestToken(d.cash).MINTER_ROLE(), d.market, "MINTER_ROLE", "the market");
        for (uint256 i; i < d.tokens.length; ++i) {
            TestStockToken token = TestStockToken(d.tokens[i].token);
            _grant(address(token), token.MINTER_ROLE(), d.market, "MINTER_ROLE", "the market");
            _grant(address(token), token.ISSUER_ROLE(), deployer, "ISSUER_ROLE", "the deployer");
        }

        TestMarket market = TestMarket(d.market);
        if (market.operator() != cfg.priceWriter) {
            market.setOperator(cfg.priceWriter);
            _tx(d.market, string.concat("setOperator(", vm.toString(cfg.priceWriter), "), the price writer"));
        }
        for (uint256 i; i < d.tokens.length; ++i) {
            Token memory t = cfg.tokens[i];
            Listed memory l = d.tokens[i];
            _feed(TestPriceFeed(l.feed), t, cfg.priceWriter);
            _feed(TestPriceFeed(l.average), t, cfg.priceWriter);
            if (market.feedOf(l.token) != l.feed) {
                market.setFeed(l.token, l.feed);
                _tx(d.market, string.concat("setFeed(", t.symbol, ", its price contract)"));
            }
            if (market.poolSqrtPrice(l.token) == 0) {
                market.open(l.token);
                _tx(
                    d.market,
                    string.concat(
                        "open(", t.symbol, "): the ", t.symbol, "/", cfg.cashSymbol, " pool at its test price"
                    )
                );
            }
            if (market.poolLiquidity(l.token) == 0) {
                market.seed(l.token, cfg.cashPerSide);
                _tx(
                    d.market,
                    string.concat(
                        "seed the ", t.symbol, " pool over the whole range, ", _n(cfg.cashPerSide), " raw cash a side"
                    )
                );
            }
            d.tokens[i].poolId = market.poolId(l.token);
        }
    }

    /// The asset entries of the vault's config (`script/config/<chain id>.json`, `Deploy.s.sol`) for the
    /// deployed tokens: each priced by its test price contract and its average, its issuer's pause and its
    /// multiplier's schedule read on the token, a US stock, the keeper's switch on, within `[min, max]`.
    function vaultAsset(address feed, address average, address token, uint128 minPrice, uint128 maxPrice)
        public
        pure
        returns (AssetConfig memory)
    {
        return AssetConfig({
            feed: feed,
            tokenDecimals: 18,
            feedDecimals: 8,
            maxAge: 26 hours,
            session: 1,
            source: 1,
            maxWeightBps: 5000,
            pauseProbe: token,
            pauseSelector: PAUSED,
            scheduleSelector: EFFECTIVE_AT,
            haltUntil: 0,
            flags: 1,
            averageFeed: average,
            minPrice: minPrice,
            maxPrice: maxPrice
        });
    }

    // ---- the file

    function readConfig(string memory path) public view returns (Config memory cfg) {
        return parseConfig(vm.readFile(path));
    }

    function parseConfig(string memory json) public view returns (Config memory cfg) {
        cfg.chainId = json.readUint(".chainId");
        cfg.salt = json.readString(".salt");
        cfg.priceWriter = vm.envOr("PRICE_WRITER", json.readAddress(".priceWriter"));
        cfg.cashSymbol = json.readString(".cash.symbol");
        cfg.cashName = json.readString(".cash.name");
        cfg.cashModelOf = json.readString(".cash.modelOf");
        cfg.cashDecimals = uint8(_fit(json, ".cash.decimals", 18));
        cfg.poolManager = json.readAddress(".uniswap.poolManager");
        cfg.permit2 = json.readAddress(".uniswap.permit2");
        cfg.fee = uint24(_fit(json, ".uniswap.fee", 1_000_000));
        cfg.tickSpacing = int24(int256(_fit(json, ".uniswap.tickSpacing", 16_383)));
        cfg.driftBps = uint16(_fit(json, ".uniswap.driftBps", 10_000));
        cfg.cashPerSide = _fit(json, ".uniswap.cashPerSide", type(uint128).max);
        cfg.router = Router({
            weth9: json.readAddress(".universalRouter.weth9"),
            v2Factory: json.readAddress(".universalRouter.v2Factory"),
            v3Factory: json.readAddress(".universalRouter.v3Factory"),
            pairInitCodeHash: json.readBytes32(".universalRouter.pairInitCodeHash"),
            poolInitCodeHash: json.readBytes32(".universalRouter.poolInitCodeHash"),
            v3NFTPositionManager: json.readAddress(".universalRouter.v3NFTPositionManager"),
            v4PositionManager: json.readAddress(".universalRouter.v4PositionManager"),
            spokePool: json.readAddress(".universalRouter.spokePool"),
            creationCode: vm.readFile(json.readString(".universalRouter.artifact")).readBytes(".creationCode")
        });
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".tokens[", vm.toString(n), "]"))) ++n;
        cfg.tokens = new Token[](n);
        for (uint256 i; i < n; ++i) {
            string memory e = string.concat(".tokens[", vm.toString(i), "]");
            cfg.tokens[i] = Token({
                symbol: json.readString(string.concat(e, ".symbol")),
                name: json.readString(string.concat(e, ".name")),
                modelOf: json.readString(string.concat(e, ".modelOf")),
                decimals: uint8(_fit(json, string.concat(e, ".decimals"), 18)),
                source: json.readAddress(string.concat(e, ".source.feed")),
                sourceDescription: json.readString(string.concat(e, ".source.description")),
                feedDecimals: uint8(_fit(json, string.concat(e, ".source.decimals"), 18)),
                answer: int256(_fit(json, string.concat(e, ".initialPrice.answer"), uint256(type(int256).max))),
                updatedAt: _fit(json, string.concat(e, ".initialPrice.updatedAt"), type(uint64).max)
            });
        }
    }

    /// What the run deployed, for the copier, the vault's config and the app.
    function recordJson(Config memory cfg, Deployed memory d) public returns (string memory) {
        string memory tokens = "[";
        for (uint256 i; i < d.tokens.length; ++i) {
            Token memory t = cfg.tokens[i];
            Listed memory l = d.tokens[i];
            string memory key = string.concat("token", vm.toString(i));
            vm.serializeString(key, "symbol", t.symbol);
            vm.serializeString(key, "modelOf", t.modelOf);
            vm.serializeAddress(key, "address", l.token);
            vm.serializeUint(key, "decimals", t.decimals);
            vm.serializeAddress(key, "feed", l.feed);
            vm.serializeAddress(key, "average", l.average);
            vm.serializeUint(key, "feedDecimals", t.feedDecimals);
            vm.serializeBytes32(key, "poolId", l.poolId);
            vm.serializeAddress(key, "source", t.source);
            string memory entry = vm.serializeString(key, "sourceDescription", t.sourceDescription);
            tokens = string.concat(tokens, i == 0 ? "" : ",", entry);
        }
        tokens = string.concat(tokens, "]");

        string memory r = "record";
        vm.serializeJson(r, string.concat('{"tokens":', tokens, "}"));
        vm.serializeString(r, "network", "robinhood-testnet");
        vm.serializeUint(r, "chainId", block.chainid);
        vm.serializeString(r, "provenance", "sandbox");
        vm.serializeAddress(r, "admin", d.admin);
        vm.serializeAddress(r, "priceWriter", cfg.priceWriter);
        vm.serializeString(r, "cashSymbol", cfg.cashSymbol);
        vm.serializeAddress(r, "cash", d.cash);
        vm.serializeUint(r, "cashDecimals", cfg.cashDecimals);
        vm.serializeAddress(r, "router", d.router);
        vm.serializeString(r, "routerVersion", "2.1.2");
        vm.serializeUint(r, "routerPull", 2);
        vm.serializeAddress(r, "market", d.market);
        vm.serializeAddress(r, "poolManager", cfg.poolManager);
        vm.serializeAddress(r, "permit2", cfg.permit2);
        vm.serializeUint(r, "fee", cfg.fee);
        return vm.serializeInt(r, "tickSpacing", cfg.tickSpacing);
    }

    // ---- steps

    function _create(Config memory cfg, string memory name, bytes memory initCode) private returns (address addr) {
        bytes32 salt = keccak256(abi.encodePacked(cfg.salt, "/", name));
        addr = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
        if (addr.code.length != 0) return addr;
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok && addr.code.length != 0, CreateFailed(name, addr));
        _tx(CREATE2_DEPLOYER, string.concat("create ", name, " at ", vm.toString(addr)));
    }

    function _grant(address token, bytes32 role, address to, string memory roleName, string memory who) private {
        if (TestToken(token).hasRole(role, to)) return;
        TestToken(token).grantRole(role, to);
        _tx(token, string.concat("grantRole(", roleName, ", ", who, ")"));
    }

    /// Names the price writer and writes the file's round, the first one, from the mainnet feed.
    function _feed(TestPriceFeed feed, Token memory t, address writer) private {
        if (feed.writer() != writer) {
            feed.setWriter(writer);
            _tx(address(feed), string.concat("setWriter(", vm.toString(writer), ")"));
        }
        if (feed.latestRound() == 0) {
            feed.write(t.answer, t.updatedAt);
            _tx(
                address(feed),
                string.concat("write(", vm.toString(t.answer), ", ", _n(t.updatedAt), "), ", feed.description())
            );
        }
    }

    function _feedCode(Token memory t, address owner, bool average) private pure returns (bytes memory) {
        string memory description = string.concat(
            t.symbol, " / USD", average ? " one-hour average" : "", " (test network, from ", t.sourceDescription, ")"
        );
        return abi.encodePacked(
            type(TestPriceFeed).creationCode, abi.encode(t.feedDecimals, description, owner, address(0))
        );
    }

    /// `RouterParameters` in its field order: ten words.
    function routerArgs(Config memory cfg) public pure returns (bytes memory) {
        Router memory r = cfg.router;
        return abi.encode(
            cfg.permit2,
            r.weth9,
            r.v2Factory,
            r.v3Factory,
            r.pairInitCodeHash,
            r.poolInitCodeHash,
            cfg.poolManager,
            r.v3NFTPositionManager,
            r.v4PositionManager,
            r.spokePool
        );
    }

    function _path() private view returns (string memory) {
        return vm.envOr("TESTNET_CONFIG", string.concat("script/testnet/config/", vm.toString(block.chainid), ".json"));
    }

    function _tx(address to, string memory what) private {
        ++sent;
        console2.log(string.concat("tx ", _n(sent), "  ", vm.toString(to), "  ", what));
    }

    function _n(uint256 value) private pure returns (string memory) {
        return vm.toString(value);
    }

    function _fit(string memory json, string memory key, uint256 most) private pure returns (uint256 value) {
        value = json.readUint(key);
        require(value <= most, ValueDoesNotFit(key, value, most));
    }

    function _print(Config memory cfg, Deployed memory d) private view {
        console2.log("transactions:", sent);
        console2.log("chain id:", block.chainid);
        console2.log("admin (the deployer):", d.admin);
        console2.log("price writer:", cfg.priceWriter);
        console2.log(string.concat("cash ", cfg.cashSymbol, ":"), d.cash);
        console2.log("universal router 2.1.2:", d.router);
        console2.log("market:", d.market);
        for (uint256 i; i < d.tokens.length; ++i) {
            console2.log(string.concat(cfg.tokens[i].symbol, ":"), d.tokens[i].token);
        }
    }
}
