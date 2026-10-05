// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {IndexRegistry} from "../src/IndexRegistry.sol";
import {AssetConfig, Params} from "../src/interfaces/Types.sol";
import {VaultBeacon} from "../src/VaultBeacon.sol";
import {VaultFactory} from "../src/VaultFactory.sol";

/// Deploys the vault contracts of one chain and writes the platform's first settings: the vault logic and
/// its beacon, the factory and the registry behind their proxies, the roles, the keeper's limits, the
/// listed assets, the routers and the cash token. Everything chain-specific comes from one JSON file,
/// `script/config/<chain id>.json`, or the file `DEPLOY_CONFIG` names.
///
///   forge script script/Deploy.s.sol --rpc-url <url> --sender <deployer>
///
/// That is a dry run: it simulates against the chain the URL answers for and prints every transaction it
/// would send, numbered, with its target and what it does. Sending is `--broadcast`, and a person does
/// that, never an agent.
///
/// The second entry, `settings()`, writes the file's assets, routers, cash token and closed days into a
/// factory already deployed, as its admin (`FACTORY` names it):
///
///   FACTORY=<address> forge script script/Deploy.s.sol --sig "settings()" --rpc-url <url> --sender <admin>
///
/// It is how a test network's tokens, feeds and exchange are listed once they exist, after the deploy.
///
/// The deployer is the admin and the beacon's owner while the script runs, so that it can write the
/// settings. At the end it proposes the config's admin for both. Until that key accepts
/// (`acceptAdmin()` on the factory, `acceptOwnership()` on the beacon), the deployer still holds both.
/// The script does not call `launch()`.
contract Deploy is Script {
    using stdJson for string;

    struct Asset {
        address token;
        AssetConfig config;
    }

    struct Router {
        address router;
        uint8 pull;
    }

    struct Config {
        uint256 chainId;
        /// The deployer stays the admin and the beacon's owner: one key, as on a test network.
        bool adminIsDeployer;
        address admin;
        address guardian;
        address keeper;
        address sequencerFeed;
        uint32 publishDelay;
        Params params;
        uint16 priceDevBps;
        address cashToken;
        Asset[] assets;
        Router[] routers;
        uint32[] closedDays;
    }

    struct Deployed {
        address vaultLogic;
        address beacon;
        address factoryLogic;
        address factory;
        address registryLogic;
        address registry;
    }

    error WrongChain(uint256 configIsFor, uint256 runningOn);
    error NoAdmin();
    /// A number in the file is too large for its field, or a selector is not four bytes long.
    error ValueDoesNotFit(string key, uint256 value, uint256 most);

    /// Transactions printed so far in this run.
    uint256 public sent;

    function run() external returns (Deployed memory d) {
        Config memory cfg = readConfig(_path());
        vm.startBroadcast();
        d = deploy(cfg, msg.sender);
        vm.stopBroadcast();
        _print(cfg, d, msg.sender);
    }

    /// Lists the file's assets, routers, cash token and closed days on the factory `FACTORY` names, and sets
    /// the keeper's limits, as its admin. Nothing else: no role changes hands.
    function settings() external {
        Config memory cfg = readConfig(_path());
        VaultFactory factory = VaultFactory(vm.envAddress("FACTORY"));
        vm.startBroadcast();
        writeSettings(cfg, factory);
        vm.stopBroadcast();
        console2.log("factory:", address(factory));
        console2.log("transactions:", sent);
    }

    /// Deploys and configures, as `deployer`: the address the calls below come from.
    function deploy(Config memory cfg, address deployer) public returns (Deployed memory d) {
        require(cfg.chainId == block.chainid, WrongChain(cfg.chainId, block.chainid));
        if (cfg.adminIsDeployer) cfg.admin = deployer;
        require(cfg.admin != address(0), NoAdmin());

        // Every proxy is created with its init call inside its constructor, and the beacon with its owner.
        d.vaultLogic = address(new BasketVault());
        _tx(d.vaultLogic, "create the vault logic (BasketVault)");
        d.beacon = address(new VaultBeacon(d.vaultLogic, deployer));
        _tx(d.beacon, "create the beacon (VaultBeacon), owned by the deployer, pointing at the vault logic");
        d.factoryLogic = address(new VaultFactory());
        _tx(d.factoryLogic, "create the factory logic (VaultFactory)");
        bytes memory init = abi.encodeCall(VaultFactory.initialize, (deployer, d.beacon, cfg.params));
        d.factory = address(new ERC1967Proxy(d.factoryLogic, init));
        _tx(d.factory, "create the factory proxy: initialize(deployer as admin, beacon, keeper limits)");
        d.registryLogic = address(new IndexRegistry());
        _tx(d.registryLogic, "create the registry logic (IndexRegistry)");
        init = abi.encodeCall(IndexRegistry.initialize, (d.factory, cfg.publishDelay));
        d.registry = address(new ERC1967Proxy(d.registryLogic, init));
        _tx(d.registry, string.concat("create the registry proxy: initialize(factory, ", _n(cfg.publishDelay), " s)"));

        VaultFactory factory = VaultFactory(d.factory);
        factory.setRegistry(d.registry);
        _tx(d.factory, "setRegistry(registry)");
        factory.setGuardian(cfg.guardian);
        _tx(d.factory, string.concat("setGuardian(", vm.toString(cfg.guardian), ")"));
        factory.setKeeper(cfg.keeper);
        _tx(d.factory, string.concat("setKeeper(", vm.toString(cfg.keeper), ")"));
        if (cfg.sequencerFeed != address(0)) {
            factory.setSequencerFeed(cfg.sequencerFeed);
            _tx(d.factory, string.concat("setSequencerFeed(", vm.toString(cfg.sequencerFeed), ")"));
        }
        writeSettings(cfg, factory);

        // Hand both keys over. Each takes the new holder's own call to complete.
        if (cfg.admin != deployer) {
            factory.proposeAdmin(cfg.admin);
            _tx(d.factory, string.concat("proposeAdmin(", vm.toString(cfg.admin), ")"));
            VaultBeacon(d.beacon).transferOwnership(cfg.admin);
            _tx(d.beacon, string.concat("transferOwnership(", vm.toString(cfg.admin), ")"));
        }
    }

    /// The settings that are the admin's to write at any time: the price deviation, the assets, the cash
    /// token, the routers and the closed days. The keeper's other limits went in with `initialize`.
    function writeSettings(Config memory cfg, VaultFactory factory) public {
        address to = address(factory);
        factory.setPriceDevBps(cfg.priceDevBps);
        _tx(to, string.concat("setPriceDevBps(", _n(cfg.priceDevBps), ")"));
        for (uint256 i; i < cfg.assets.length; ++i) {
            Asset memory a = cfg.assets[i];
            factory.setAsset(a.token, a.config);
            _tx(
                to,
                string.concat(
                    "setAsset(",
                    vm.toString(a.token),
                    ", feed ",
                    vm.toString(a.config.feed),
                    ", average ",
                    vm.toString(a.config.averageFeed),
                    ", range ",
                    _n(a.config.minPrice),
                    " to ",
                    _n(a.config.maxPrice),
                    ", keeper ",
                    a.config.flags == 1 ? "on)" : "off)"
                )
            );
        }
        if (cfg.cashToken != address(0)) {
            factory.setCashToken(cfg.cashToken);
            _tx(to, string.concat("setCashToken(", vm.toString(cfg.cashToken), ")"));
        }
        for (uint256 i; i < cfg.routers.length; ++i) {
            factory.setRouter(cfg.routers[i].router, cfg.routers[i].pull);
            _tx(
                to,
                string.concat("setRouter(", vm.toString(cfg.routers[i].router), ", pull ", _n(cfg.routers[i].pull), ")")
            );
        }
        for (uint256 i; i < cfg.closedDays.length; ++i) {
            factory.setClosedDay(cfg.closedDays[i], true);
            _tx(to, string.concat("setClosedDay(", _n(cfg.closedDays[i]), ", closed)"));
        }
    }

    function readConfig(string memory path) public view returns (Config memory cfg) {
        return parseConfig(vm.readFile(path));
    }

    /// Every number is held to the size of the field it goes into: a value that does not fit is refused, not
    /// cut down (a `pull` of 257 would otherwise be read as 1).
    function parseConfig(string memory json) public view returns (Config memory cfg) {
        cfg.chainId = json.readUint(".chainId");
        cfg.adminIsDeployer = vm.keyExistsJson(json, ".adminIsDeployer") && json.readBool(".adminIsDeployer");
        cfg.admin = json.readAddress(".admin");
        cfg.guardian = json.readAddress(".guardian");
        cfg.keeper = json.readAddress(".keeper");
        cfg.sequencerFeed = json.readAddress(".sequencerFeed");
        cfg.publishDelay = uint32(_fit(json, ".publishDelay", type(uint32).max));
        cfg.params = Params({
            toleranceBps: uint16(_fit(json, ".params.toleranceBps", type(uint16).max)),
            lossCapBps: uint16(_fit(json, ".params.lossCapBps", type(uint16).max)),
            bandBps: uint16(_fit(json, ".params.bandBps", type(uint16).max)),
            assetCooldown: uint32(_fit(json, ".params.assetCooldown", type(uint32).max)),
            sessionOpen: uint32(_fit(json, ".params.sessionOpen", type(uint32).max)),
            sessionClose: uint32(_fit(json, ".params.sessionClose", type(uint32).max))
        });
        cfg.priceDevBps = uint16(_fit(json, ".priceDevBps", type(uint16).max));
        cfg.cashToken = json.readAddress(".cashToken");

        uint256 n = _count(json, ".assets");
        cfg.assets = new Asset[](n);
        for (uint256 i; i < n; ++i) {
            string memory entry = string.concat(".assets[", vm.toString(i), "]");
            cfg.assets[i].token = json.readAddress(string.concat(entry, ".token"));
            cfg.assets[i].config = AssetConfig({
                feed: json.readAddress(string.concat(entry, ".feed")),
                tokenDecimals: uint8(_fit(json, string.concat(entry, ".tokenDecimals"), type(uint8).max)),
                feedDecimals: uint8(_fit(json, string.concat(entry, ".feedDecimals"), type(uint8).max)),
                maxAge: uint32(_fit(json, string.concat(entry, ".maxAge"), type(uint32).max)),
                session: uint8(_fit(json, string.concat(entry, ".session"), type(uint8).max)),
                source: uint8(_fit(json, string.concat(entry, ".source"), type(uint8).max)),
                maxWeightBps: uint16(_fit(json, string.concat(entry, ".maxWeightBps"), type(uint16).max)),
                pauseProbe: json.readAddress(string.concat(entry, ".pauseProbe")),
                pauseSelector: _selector(json, string.concat(entry, ".pauseSelector")),
                scheduleSelector: _selector(json, string.concat(entry, ".scheduleSelector")),
                haltUntil: 0,
                flags: uint8(_fit(json, string.concat(entry, ".flags"), type(uint8).max)),
                averageFeed: json.readAddress(string.concat(entry, ".averageFeed")),
                minPrice: uint128(_fit(json, string.concat(entry, ".minPrice"), type(uint128).max)),
                maxPrice: uint128(_fit(json, string.concat(entry, ".maxPrice"), type(uint128).max))
            });
        }

        n = _count(json, ".routers");
        cfg.routers = new Router[](n);
        for (uint256 i; i < n; ++i) {
            string memory entry = string.concat(".routers[", vm.toString(i), "]");
            cfg.routers[i] = Router({
                router: json.readAddress(string.concat(entry, ".router")),
                pull: uint8(_fit(json, string.concat(entry, ".pull"), type(uint8).max))
            });
        }

        n = _count(json, ".closedDays");
        cfg.closedDays = new uint32[](n);
        for (uint256 i; i < n; ++i) {
            string memory entry = string.concat(".closedDays[", vm.toString(i), "]");
            cfg.closedDays[i] = uint32(_fit(json, entry, type(uint32).max));
        }
    }

    function _path() private view returns (string memory) {
        return vm.envOr("DEPLOY_CONFIG", string.concat("script/config/", vm.toString(block.chainid), ".json"));
    }

    /// One transaction of the run, printed as it is made: its number, its target and what it does.
    function _tx(address to, string memory what) private {
        ++sent;
        console2.log(string.concat("tx ", _n(sent), "  ", vm.toString(to), "  ", what));
    }

    function _n(uint256 value) private pure returns (string memory) {
        return vm.toString(value);
    }

    function _count(string memory json, string memory list) private view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(list, "[", vm.toString(n), "]"))) ++n;
    }

    function _fit(string memory json, string memory key, uint256 most) private pure returns (uint256 value) {
        value = json.readUint(key);
        require(value <= most, ValueDoesNotFit(key, value, most));
    }

    /// A selector is exactly four bytes.
    function _selector(string memory json, string memory key) private pure returns (bytes4) {
        bytes memory raw = json.readBytes(key);
        require(raw.length == 4, ValueDoesNotFit(key, raw.length, 4));
        return bytes4(raw);
    }

    function _print(Config memory cfg, Deployed memory d, address deployer) private view {
        console2.log("transactions:", sent);
        console2.log("chain id:", block.chainid);
        console2.log("deployer:", deployer);
        console2.log("vault logic:    ", d.vaultLogic);
        console2.log("beacon:         ", d.beacon);
        console2.log("factory logic:  ", d.factoryLogic);
        console2.log("factory (proxy):", d.factory);
        console2.log("registry logic: ", d.registryLogic);
        console2.log("registry (proxy):", d.registry);
        console2.log("guardian:", cfg.guardian);
        console2.log("keeper:  ", cfg.keeper);
        console2.log("cash token:", cfg.cashToken);
        console2.log("assets listed:", cfg.assets.length);
        console2.log("routers allowed:", cfg.routers.length);
        console2.log("closed days set:", cfg.closedDays.length);
        console2.log("publish delay, seconds:", uint256(cfg.publishDelay));
        if (cfg.admin == deployer) {
            console2.log("admin and beacon owner: the deployer");
        } else {
            console2.log("admin and beacon owner now: the deployer");
            console2.log("proposed for both:", cfg.admin);
            console2.log("still to do, by that key: factory.acceptAdmin() and beacon.acceptOwnership()");
        }
    }
}
