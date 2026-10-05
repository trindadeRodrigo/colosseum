// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {IndexRegistry} from "../src/IndexRegistry.sol";
import {IVaultConfig} from "../src/interfaces/IVaultConfig.sol";
import {IVaultFactory} from "../src/interfaces/IVaultFactory.sol";
import {AssetConfig, Params, Weight} from "../src/interfaces/Types.sol";
import {VaultBeacon} from "../src/VaultBeacon.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {MockRouter} from "./mocks/Routers.sol";
import {MockToken} from "./mocks/Tokens.sol";

/// The deploy script, run inside a test: what it deploys, how it wires the contracts together, and who
/// holds what when it ends. Nothing here reaches a network.
contract DeployTest is Test {
    Deploy internal script;
    address internal deployer;
    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        script = new Deploy();
        // With no broadcast, the script's calls come from the script itself.
        deployer = address(script);
    }

    function _config() internal view returns (Deploy.Config memory cfg) {
        cfg.chainId = block.chainid;
        cfg.admin = admin;
        cfg.guardian = guardian;
        cfg.keeper = keeper;
        cfg.publishDelay = 300;
        cfg.params = Params(125, 200, 50, 3600, 52_200, 72_000);
        cfg.priceDevBps = 200;
    }

    function test_deploy_fromTheLocalFile() public {
        Deploy.Config memory cfg = script.readConfig("script/config/31337.json");
        assertEq(cfg.chainId, block.chainid, "the test chain is anvil's");
        Deploy.Deployed memory d = script.deploy(cfg, deployer);

        VaultFactory factory = VaultFactory(d.factory);
        IndexRegistry registry = IndexRegistry(d.registry);
        VaultBeacon beacon = VaultBeacon(d.beacon);

        // Wired together.
        assertEq(beacon.implementation(), d.vaultLogic);
        assertEq(factory.beacon(), d.beacon);
        assertEq(factory.registry(), d.registry);
        assertEq(registry.factory(), d.factory);
        assertEq(_logicOf(d.factory), d.factoryLogic);
        assertEq(_logicOf(d.registry), d.registryLogic);

        // The settings of the file.
        assertEq(factory.guardian(), cfg.guardian);
        assertEq(factory.keeper(), cfg.keeper);
        assertEq(factory.sequencerFeed(), address(0));
        assertEq(registry.publishDelay(), 300);
        (uint16 tolerance, uint16 lossCap, uint16 band, uint32 cooldown, uint32 open, uint32 close) = factory.params();
        assertEq(tolerance, 125);
        assertEq(lossCap, 200);
        assertEq(band, 50);
        assertEq(cooldown, 3600);
        assertEq(open, 52_200);
        assertEq(close, 72_000);
        assertTrue(factory.closedDay(20_813));
        assertTrue(factory.closedDay(20_843));
        assertFalse(factory.closedDay(20_814));
        assertFalse(factory.launched(), "launch is a person's decision, not the script's");
        assertFalse(factory.keeperPaused());
        assertEq(factory.assets().length, 0);
        assertEq(factory.cashToken(), address(0));

        // The deployer holds both keys until the admin accepts each, and cannot launch in between.
        assertEq(factory.admin(), deployer);
        assertEq(factory.pendingAdmin(), cfg.admin);
        assertEq(beacon.owner(), deployer);
        assertEq(beacon.pendingOwner(), cfg.admin);
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.AdminHandoverPending.selector, cfg.admin));
        factory.launch();

        // One accept without the other is still a hand-over half done.
        vm.startPrank(cfg.admin);
        factory.acceptAdmin();
        vm.expectRevert(abi.encodeWithSelector(IVaultFactory.BeaconNotTheAdmins.selector, deployer, cfg.admin));
        factory.launch();
        beacon.acceptOwnership();
        vm.stopPrank();
        assertEq(factory.admin(), cfg.admin);
        assertEq(beacon.owner(), cfg.admin);
        assertFalse(factory.launched());
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, deployer));
        vm.prank(deployer);
        factory.setKeeper(deployer);
        // With both keys handed over, the launch is the admin's to make.
        vm.prank(cfg.admin);
        factory.launch();
        assertTrue(factory.launched());

        // No logic contract can be initialised by anyone.
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        BasketVault(payable(d.vaultLogic)).initialize(address(this), bytes32(0));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        VaultFactory(d.factoryLogic).initialize(address(this), d.beacon, cfg.params);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        IndexRegistry(d.registryLogic).initialize(d.factory, 300);
    }

    /// With assets, routers and a cash token, and then the first thing a person does: create a vault.
    function test_deploy_listsAssetsRoutersAndCash_andAVaultCanBeMade() public {
        MockToken cash = new MockToken(6);
        MockToken stock = new MockToken(18);
        MockRouter router = new MockRouter(true);
        Deploy.Config memory cfg = _config();
        cfg.cashToken = address(cash);
        cfg.sequencerFeed = makeAddr("sequencer-feed");
        cfg.assets = new Deploy.Asset[](2);
        cfg.assets[0] = Deploy.Asset(address(cash), _asset(6, 0, 5000));
        cfg.assets[1] = Deploy.Asset(address(stock), _asset(18, 1, 2500));
        cfg.routers = new Deploy.Router[](1);
        cfg.routers[0] = Deploy.Router(address(router), 2);

        Deploy.Deployed memory d = script.deploy(cfg, deployer);
        VaultFactory factory = VaultFactory(d.factory);

        assertEq(factory.cashToken(), address(cash));
        assertEq(factory.assets().length, 2);
        assertEq(factory.asset(address(stock)).maxWeightBps, 2500);
        assertEq(factory.asset(address(stock)).session, 1);
        assertEq(factory.routerPull(address(router)), 2);
        assertEq(factory.sequencerFeed(), cfg.sequencerFeed);

        address person = makeAddr("person");
        Weight[] memory targets = new Weight[](1);
        targets[0] = Weight(address(stock), 5000);
        vm.prank(person);
        address vault = factory.createVault(keccak256("plan"), targets, bytes32(0), 0, false);
        assertEq(BasketVault(payable(vault)).owner(), person);
        assertTrue(factory.isVault(vault));
    }

    /// When the deployer is the admin, as on a test network with one key, nothing is proposed.
    function test_deploy_whenTheDeployerIsTheAdmin() public {
        Deploy.Config memory cfg = _config();
        cfg.admin = deployer;
        Deploy.Deployed memory d = script.deploy(cfg, deployer);
        assertEq(VaultFactory(d.factory).admin(), deployer);
        assertEq(VaultFactory(d.factory).pendingAdmin(), address(0));
        assertEq(VaultBeacon(d.beacon).pendingOwner(), address(0));
    }

    /// A file written for one chain is refused on another: the local file's roles are public test keys.
    function test_deploy_refusesAFileForAnotherChain() public {
        Deploy.Config memory cfg = script.readConfig("script/config/31337.json");
        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, 31_337, 4663));
        script.deploy(cfg, deployer);
    }

    /// Robinhood Chain's test network: one key, the deployer's, holds the admin and the beacon; nothing is
    /// listed until the test tokens, feeds and exchange exist; the closed days ahead are set. A dry run of
    /// the file against the network gives the same transactions.
    function test_deploy_theTestNetworkFile() public {
        Deploy.Config memory cfg = script.readConfig("script/config/46630.json");
        assertTrue(cfg.adminIsDeployer);
        vm.chainId(46_630);
        Deploy.Deployed memory d = script.deploy(cfg, deployer);
        VaultFactory factory = VaultFactory(d.factory);
        assertEq(factory.admin(), deployer);
        assertEq(factory.pendingAdmin(), address(0));
        assertEq(VaultBeacon(d.beacon).owner(), deployer);
        assertEq(VaultBeacon(d.beacon).pendingOwner(), address(0));
        assertEq(factory.guardian(), address(0), "the admin makes the guardian's calls");
        assertEq(factory.keeper(), address(0), "set when the keeper key is made");
        assertEq(factory.priceDevBps(), 200);
        (, uint16 lossCap,,,,) = factory.params();
        assertEq(lossCap, 100, "a person is told 2% in any seven days");
        assertEq(IndexRegistry(d.registry).publishDelay(), 300);
        assertTrue(factory.closedDay(20_783), "Thanksgiving 2026");
        assertTrue(factory.closedDay(21_176));
        assertEq(factory.assets().length, 0);
        // 6 creations, the registry, the guardian, the keeper, the price deviation and 12 closed days.
        assertEq(script.sent(), 6 + 4 + 12);
    }

    /// `settings()`: what a test network lists once its tokens exist, written into the deployed factory.
    function test_writeSettings_listsOnADeployedFactory() public {
        Deploy.Deployed memory d = script.deploy(_config(), deployer);
        MockToken cash = new MockToken(6);
        MockToken stock = new MockToken(18);
        MockRouter router = new MockRouter(true);
        Deploy.Config memory cfg = _config();
        cfg.cashToken = address(cash);
        cfg.assets = new Deploy.Asset[](2);
        cfg.assets[0] = Deploy.Asset(address(cash), _asset(6, 0, 5000));
        cfg.assets[1] = Deploy.Asset(address(stock), _asset(18, 1, 2500));
        cfg.assets[1].config.flags = 1;
        cfg.assets[1].config.averageFeed = makeAddr("average");
        cfg.assets[1].config.minPrice = 150e8;
        cfg.assets[1].config.maxPrice = 250e8;
        cfg.routers = new Deploy.Router[](1);
        cfg.routers[0] = Deploy.Router(address(router), 2);
        cfg.priceDevBps = 150;
        script.writeSettings(cfg, VaultFactory(d.factory));
        VaultFactory factory = VaultFactory(d.factory);
        assertEq(factory.cashToken(), address(cash));
        assertEq(factory.asset(address(stock)).flags, 1);
        assertEq(factory.asset(address(stock)).maxPrice, 250e8);
        assertEq(factory.routerPull(address(router)), 2);
        assertEq(factory.priceDevBps(), 150);
    }

    function test_deploy_refusesAFileWithNoAdmin() public {
        Deploy.Config memory cfg = _config();
        cfg.admin = address(0);
        vm.expectRevert(Deploy.NoAdmin.selector);
        script.deploy(cfg, deployer);
    }

    /// The example file shows every field, and deploys nowhere.
    function test_readConfig_readsEveryFieldOfTheExample() public {
        Deploy.Config memory cfg = script.readConfig("script/config/example.json");
        assertEq(cfg.chainId, 0);
        assertEq(cfg.admin, address(0));
        assertEq(cfg.guardian, address(2));
        assertEq(cfg.keeper, address(3));
        assertEq(cfg.sequencerFeed, address(4));
        assertEq(cfg.publishDelay, 172_800);
        assertEq(cfg.params.toleranceBps, 125);
        assertEq(cfg.params.sessionClose, 72_000);
        assertEq(cfg.cashToken, 0x1111111111111111111111111111111111111111);
        assertEq(cfg.assets.length, 2);
        assertEq(cfg.assets[0].token, cfg.cashToken);
        assertEq(cfg.assets[0].config.tokenDecimals, 6);
        assertEq(cfg.assets[0].config.session, 0);
        assertEq(cfg.assets[1].token, 0x3333333333333333333333333333333333333333);
        assertEq(cfg.assets[1].config.feed, 0x4444444444444444444444444444444444444444);
        assertEq(cfg.assets[1].config.tokenDecimals, 18);
        assertEq(cfg.assets[1].config.feedDecimals, 8);
        assertEq(cfg.assets[1].config.maxAge, 93_600);
        assertEq(cfg.assets[1].config.session, 1);
        assertEq(cfg.assets[1].config.source, 1);
        assertEq(cfg.assets[1].config.maxWeightBps, 2500);
        assertEq(cfg.assets[1].config.pauseProbe, cfg.assets[1].token);
        assertEq(cfg.assets[1].config.pauseSelector, bytes4(keccak256("paused()")));
        assertEq(cfg.assets[1].config.scheduleSelector, bytes4(keccak256("effectiveAt()")));
        assertEq(cfg.assets[1].config.haltUntil, 0);
        assertEq(cfg.assets[0].config.flags, 0);
        assertEq(cfg.assets[1].config.flags, 1);
        assertEq(cfg.assets[1].config.averageFeed, 0x6666666666666666666666666666666666666666);
        assertEq(cfg.assets[1].config.minPrice, 150e8);
        assertEq(cfg.assets[1].config.maxPrice, 250e8);
        assertEq(cfg.priceDevBps, 200);
        assertFalse(cfg.adminIsDeployer);
        assertEq(cfg.routers.length, 1);
        assertEq(cfg.routers[0].router, 0x5555555555555555555555555555555555555555);
        assertEq(cfg.routers[0].pull, 2);
        assertEq(cfg.closedDays.length, 1);
        assertEq(cfg.closedDays[0], 20_813);

        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, 0, block.chainid));
        script.deploy(cfg, deployer);
    }

    /// A number too large for its field is refused, never cut down: `"pull": 257` is not pull 1, and a
    /// `maxWeightBps` of 70,536 is not 5,000.
    function test_parseConfig_refusesANumberThatDoesNotFitItsField() public {
        string memory example = vm.readFile("script/config/example.json");
        script.parseConfig(example);

        _expectNoFit(example, '"pull": 2', '"pull": 257', ".routers[0].pull", 257, type(uint8).max);
        _expectNoFit(example, '"tokenDecimals": 18', '"tokenDecimals": 274', ".assets[1].tokenDecimals", 274, 255);
        _expectNoFit(example, '"feedDecimals": 8', '"feedDecimals": 264', ".assets[0].feedDecimals", 264, 255);
        _expectNoFit(example, '"session": 1', '"session": 257', ".assets[1].session", 257, 255);
        _expectNoFit(example, '"source": 1', '"source": 257', ".assets[0].source", 257, 255);
        _expectNoFit(
            example, '"maxWeightBps": 2500', '"maxWeightBps": 70536', ".assets[1].maxWeightBps", 70_536, 65_535
        );
        _expectNoFit(
            example, '"maxAge": 93600', '"maxAge": 4294967297', ".assets[0].maxAge", 4_294_967_297, 2 ** 32 - 1
        );
        _expectNoFit(
            example, '"publishDelay": 172800', '"publishDelay": 4295140096', ".publishDelay", 4_295_140_096, 2 ** 32 - 1
        );
        _expectNoFit(example, '"toleranceBps": 125', '"toleranceBps": 65661', ".params.toleranceBps", 65_661, 65_535);
        _expectNoFit(
            example,
            '"assetCooldown": 3600',
            '"assetCooldown": 4294970896',
            ".params.assetCooldown",
            4_294_970_896,
            2 ** 32 - 1
        );
        _expectNoFit(
            example, '"closedDays": [20813]', '"closedDays": [4294988109]', ".closedDays[0]", 4_294_988_109, 2 ** 32 - 1
        );
    }

    function test_parseConfig_refusesASelectorThatIsNotFourBytes() public {
        string memory example = vm.readFile("script/config/example.json");
        string memory bad = vm.replace(example, '"pauseSelector": "0x5c975abb"', '"pauseSelector": "0x5c975abb00"');
        vm.expectRevert(abi.encodeWithSelector(Deploy.ValueDoesNotFit.selector, ".assets[1].pauseSelector", 5, 4));
        script.parseConfig(bad);
    }

    function _expectNoFit(
        string memory example,
        string memory from,
        string memory to,
        string memory key,
        uint256 value,
        uint256 most
    ) internal {
        string memory bad = vm.replace(example, from, to);
        assertTrue(keccak256(bytes(bad)) != keccak256(bytes(example)), from);
        vm.expectRevert(abi.encodeWithSelector(Deploy.ValueDoesNotFit.selector, key, value, most));
        script.parseConfig(bad);
    }

    function _asset(uint8 tokenDecimals, uint8 session, uint16 maxWeightBps) internal returns (AssetConfig memory) {
        return AssetConfig({
            feed: makeAddr("feed"),
            tokenDecimals: tokenDecimals,
            feedDecimals: 8,
            maxAge: 26 hours,
            session: session,
            source: 1,
            maxWeightBps: maxWeightBps,
            pauseProbe: address(0),
            pauseSelector: bytes4(0),
            scheduleSelector: bytes4(0),
            haltUntil: 0,
            flags: 0,
            averageFeed: address(0),
            minPrice: 0,
            maxPrice: 0
        });
    }

    function _logicOf(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }
}
