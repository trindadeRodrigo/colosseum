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
/// That is a dry run: it simulates against the chain the URL answers for and prints what it would deploy.
/// Sending is `--broadcast`, and a person does that, never an agent.
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
        address admin;
        address guardian;
        address keeper;
        address sequencerFeed;
        uint32 publishDelay;
        Params params;
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

    function run() external returns (Deployed memory d) {
        string memory fallbackPath = string.concat("script/config/", vm.toString(block.chainid), ".json");
        Config memory cfg = readConfig(vm.envOr("DEPLOY_CONFIG", fallbackPath));
        vm.startBroadcast();
        d = deploy(cfg, msg.sender);
        vm.stopBroadcast();
        _print(cfg, d, msg.sender);
    }

    /// Deploys and configures, as `deployer`: the address the calls below come from.
    function deploy(Config memory cfg, address deployer) public returns (Deployed memory d) {
        require(cfg.chainId == block.chainid, WrongChain(cfg.chainId, block.chainid));
        require(cfg.admin != address(0), NoAdmin());

        // Every proxy is created with its init call inside its constructor, and the beacon with its owner.
        d.vaultLogic = address(new BasketVault());
        d.beacon = address(new VaultBeacon(d.vaultLogic, deployer));
        d.factoryLogic = address(new VaultFactory());
        bytes memory init = abi.encodeCall(VaultFactory.initialize, (deployer, d.beacon, cfg.params));
        d.factory = address(new ERC1967Proxy(d.factoryLogic, init));
        d.registryLogic = address(new IndexRegistry());
        init = abi.encodeCall(IndexRegistry.initialize, (d.factory, cfg.publishDelay));
        d.registry = address(new ERC1967Proxy(d.registryLogic, init));

        VaultFactory factory = VaultFactory(d.factory);
        factory.setRegistry(d.registry);
        factory.setGuardian(cfg.guardian);
        factory.setKeeper(cfg.keeper);
        if (cfg.sequencerFeed != address(0)) factory.setSequencerFeed(cfg.sequencerFeed);
        for (uint256 i; i < cfg.assets.length; ++i) {
            factory.setAsset(cfg.assets[i].token, cfg.assets[i].config);
        }
        if (cfg.cashToken != address(0)) factory.setCashToken(cfg.cashToken);
        for (uint256 i; i < cfg.routers.length; ++i) {
            factory.setRouter(cfg.routers[i].router, cfg.routers[i].pull);
        }
        for (uint256 i; i < cfg.closedDays.length; ++i) {
            factory.setClosedDay(cfg.closedDays[i], true);
        }

        // Hand both keys over. Each takes the new holder's own call to complete.
        if (cfg.admin != deployer) {
            factory.proposeAdmin(cfg.admin);
            VaultBeacon(d.beacon).transferOwnership(cfg.admin);
        }
    }

    function readConfig(string memory path) public view returns (Config memory cfg) {
        string memory json = vm.readFile(path);
        cfg.chainId = json.readUint(".chainId");
        cfg.admin = json.readAddress(".admin");
        cfg.guardian = json.readAddress(".guardian");
        cfg.keeper = json.readAddress(".keeper");
        cfg.sequencerFeed = json.readAddress(".sequencerFeed");
        cfg.publishDelay = uint32(json.readUint(".publishDelay"));
        cfg.params = Params({
            toleranceBps: uint16(json.readUint(".params.toleranceBps")),
            lossCapBps: uint16(json.readUint(".params.lossCapBps")),
            bandBps: uint16(json.readUint(".params.bandBps")),
            assetCooldown: uint32(json.readUint(".params.assetCooldown")),
            sessionOpen: uint32(json.readUint(".params.sessionOpen")),
            sessionClose: uint32(json.readUint(".params.sessionClose"))
        });
        cfg.cashToken = json.readAddress(".cashToken");

        uint256 n = _count(json, ".assets");
        cfg.assets = new Asset[](n);
        for (uint256 i; i < n; ++i) {
            string memory entry = string.concat(".assets[", vm.toString(i), "]");
            cfg.assets[i].token = json.readAddress(string.concat(entry, ".token"));
            cfg.assets[i].config = AssetConfig({
                feed: json.readAddress(string.concat(entry, ".feed")),
                tokenDecimals: uint8(json.readUint(string.concat(entry, ".tokenDecimals"))),
                feedDecimals: uint8(json.readUint(string.concat(entry, ".feedDecimals"))),
                maxAge: uint32(json.readUint(string.concat(entry, ".maxAge"))),
                session: uint8(json.readUint(string.concat(entry, ".session"))),
                source: uint8(json.readUint(string.concat(entry, ".source"))),
                maxWeightBps: uint16(json.readUint(string.concat(entry, ".maxWeightBps"))),
                pauseProbe: json.readAddress(string.concat(entry, ".pauseProbe")),
                pauseSelector: bytes4(json.readBytes(string.concat(entry, ".pauseSelector"))),
                scheduleSelector: bytes4(json.readBytes(string.concat(entry, ".scheduleSelector"))),
                haltUntil: 0
            });
        }

        n = _count(json, ".routers");
        cfg.routers = new Router[](n);
        for (uint256 i; i < n; ++i) {
            string memory entry = string.concat(".routers[", vm.toString(i), "]");
            cfg.routers[i] = Router({
                router: json.readAddress(string.concat(entry, ".router")),
                pull: uint8(json.readUint(string.concat(entry, ".pull")))
            });
        }

        n = _count(json, ".closedDays");
        cfg.closedDays = new uint32[](n);
        for (uint256 i; i < n; ++i) {
            cfg.closedDays[i] = uint32(json.readUint(string.concat(".closedDays[", vm.toString(i), "]")));
        }
    }

    function _count(string memory json, string memory list) private view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(list, "[", vm.toString(n), "]"))) ++n;
    }

    function _print(Config memory cfg, Deployed memory d, address deployer) private view {
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
