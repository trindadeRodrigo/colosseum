// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {IVaultConfig} from "../src/interfaces/IVaultConfig.sol";
import {AssetConfig, Params, Weight} from "../src/interfaces/Types.sol";
import {VaultBeacon} from "../src/VaultBeacon.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {StubSequencerFeed} from "../testnet/StubSequencerFeed.sol";
import {TestMarket, IPoolManagerLite} from "../testnet/TestMarket.sol";
import {TestnetOnly} from "../testnet/TestnetOnly.sol";
import {TestPriceFeed} from "../testnet/TestPriceFeed.sol";
import {TestStockToken} from "../testnet/TestStockToken.sol";
import {TestToken} from "../testnet/TestToken.sol";
import {MockPermit2} from "./mocks/Routers.sol";
import {PERMIT2} from "../src/interfaces/IVaultConfig.sol";

/// A dollar token with its decimals in its code, so that it can be put at a fixed address.
contract Dollar6 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// A stock token as Robinhood's answers: 18 decimals, `paused()`, `effectiveAt()`.
contract Stock18 {
    function decimals() external pure returns (uint8) {
        return 18;
    }

    function paused() external pure returns (bool) {
        return false;
    }

    function effectiveAt() external pure returns (uint256) {
        return 0;
    }
}

contract Aggregator {}

/// A feed as Chainlink's proxies answer: decimals, a description, the aggregator behind it, a round.
contract ChainlinkLikeFeed {
    uint8 public decimals;
    string public description;
    address public aggregator;

    constructor(uint8 decimals_, string memory description_, address aggregator_) {
        decimals = decimals_;
        description = description_;
        aggregator = aggregator_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 230e8, block.timestamp, block.timestamp, 1);
    }
}

/// What a pool-average feed says of itself (`src/price/PoolAverageFeed.sol`): the token it averages, the
/// cash it is priced in, the Chainlink feed it is checked against, and its decimals.
contract PoolAverageLike {
    address public base;
    address public quote;
    address public feed;
    uint8 public decimals;

    constructor(address base_, address quote_, address feed_, uint8 decimals_) {
        base = base_;
        quote = quote_;
        feed = feed_;
        decimals = decimals_;
    }
}

/// Stands for the Safe, and for a router: an address with code.
contract Anything {}

/// The deploy script on a mainnet: the hand-over to a timelock it creates, and every rule a mainnet file
/// is held to (M4 of the review of 2026-10-09). Nothing here reaches a network: the chain id is set in the
/// test, and stand-ins are put at the two addresses the script pins for Robinhood Chain.
contract DeployMainnetTest is Test {
    uint256 internal constant ROBINHOOD = 4663;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant UNIVERSAL_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    uint256 internal constant USD = 1e6;

    Deploy internal script;
    address internal deployer;
    address internal safe;
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    Stock18 internal stock;
    ChainlinkLikeFeed internal feed;
    PoolAverageLike internal average;

    function setUp() public {
        script = new Deploy();
        deployer = address(script);
        safe = address(new Anything());
        stock = new Stock18();
        feed = new ChainlinkLikeFeed(8, "RHNVDA / USD", address(new Aggregator()));
        average = new PoolAverageLike(address(stock), USDG, address(feed), 8);
        vm.etch(USDG, address(new Dollar6()).code);
        vm.etch(UNIVERSAL_ROUTER, address(new Anything()).code);
        vm.etch(PERMIT2, address(new MockPermit2()).code);
        vm.chainId(ROBINHOOD);
        // A chain's clock, not a test's: at second 1 a timelock operation scheduled with no delay would
        // carry the timestamp OpenZeppelin uses to mean "done".
        vm.warp(1_791_212_400);
    }

    /// A file a mainnet deploy accepts: owner-signed only, behind a Safe and a 48-hour timelock, with a
    /// guardian and both caps at $10,000.
    function _good() internal view returns (Deploy.Config memory cfg) {
        cfg.chainId = ROBINHOOD;
        cfg.timelockOwner = safe;
        cfg.timelockDelay = 48 hours;
        cfg.guardian = guardian;
        cfg.publishDelay = 172_800;
        cfg.params = Params(125, 100, 50, 3600, 52_200, 72_000);
        cfg.sessionPriceAge = 3600;
        cfg.hasCaps = true;
        cfg.vaultCap = 10_000 * USD;
        cfg.totalCap = 10_000 * USD;
        cfg.cashToken = USDG;
        cfg.assets = new Deploy.Asset[](2);
        cfg.feedDescriptions = new string[](2);
        AssetConfig memory cashConfig;
        cashConfig.tokenDecimals = 6;
        cfg.assets[0] = Deploy.Asset(USDG, cashConfig);
        cfg.assets[1] = Deploy.Asset(address(stock), _stockConfig());
        cfg.feedDescriptions[1] = "RHNVDA / USD";
        cfg.routers = new Deploy.Router[](1);
        cfg.routers[0] = Deploy.Router(UNIVERSAL_ROUTER, 2);
        cfg.closedDays = new uint32[](1);
        cfg.closedDays[0] = 20_813;
    }

    function _stockConfig() internal view returns (AssetConfig memory a) {
        a.feed = address(feed);
        a.tokenDecimals = 18;
        a.feedDecimals = 8;
        a.maxAge = 93_600;
        a.session = 1;
        a.source = 1;
        a.maxWeightBps = 2500;
        a.pauseProbe = address(stock);
        a.pauseSelector = bytes4(keccak256("paused()"));
        a.scheduleSelector = bytes4(keccak256("effectiveAt()"));
    }

    /// The good file with the keeper meant to run, inside a mainnet's limits.
    function _goodWithKeeper() internal view returns (Deploy.Config memory cfg) {
        cfg = _good();
        cfg.keeperEnabled = true;
        cfg.keeper = keeper;
        cfg.priceDevBps = 150;
        cfg.assets[1].config.flags = 1;
        cfg.assets[1].config.averageFeed = address(average);
        cfg.assets[1].config.minPrice = 200e8;
        cfg.assets[1].config.maxPrice = 270e8;
    }

    function _refused(Deploy.Config memory cfg, string memory rule) internal {
        vm.expectRevert(abi.encodeWithSelector(Deploy.MainnetRefused.selector, rule));
        script.deploy(cfg, deployer);
    }

    // ---- what a good mainnet deploy leaves behind

    function test_mainnet_endsWithTheTimelockHoldingBothKeys_andTheDeployerHoldingNothing() public {
        Deploy.Config memory cfg = _good();
        Deploy.Deployed memory d = script.deploy(cfg, deployer);
        VaultFactory factory = VaultFactory(d.factory);
        VaultBeacon beacon = VaultBeacon(d.beacon);
        TimelockController timelock = TimelockController(payable(d.timelock));

        assertGt(d.timelock.code.length, 0, "the admin is a contract");
        assertEq(factory.admin(), d.timelock);
        assertEq(factory.pendingAdmin(), address(0));
        assertEq(beacon.owner(), d.timelock);
        assertEq(beacon.pendingOwner(), address(0));
        assertEq(timelock.getMinDelay(), 48 hours);

        bytes32[4] memory roles = [
            timelock.PROPOSER_ROLE(),
            timelock.CANCELLER_ROLE(),
            timelock.EXECUTOR_ROLE(),
            timelock.DEFAULT_ADMIN_ROLE()
        ];
        for (uint256 i; i < roles.length; ++i) {
            assertFalse(timelock.hasRole(roles[i], deployer), "the deployer kept a role");
            assertFalse(timelock.hasRole(roles[i], address(0)), "a role is open to anyone");
            assertEq(timelock.hasRole(roles[i], safe), i < 3, "the Safe: proposer, canceller, executor, not admin");
        }
        assertTrue(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), d.timelock));

        // The settings of the file.
        assertEq(factory.guardian(), guardian);
        assertEq(factory.keeper(), address(0));
        assertEq(factory.cashToken(), USDG);
        assertEq(factory.routerPull(UNIVERSAL_ROUTER), 2);
        assertEq(factory.sessionPriceAge(), 3600);
        (uint256 perVault, uint256 total) = factory.depositCaps();
        assertEq(perVault, 10_000 * USD);
        assertEq(total, 10_000 * USD);
        assertFalse(factory.launched(), "launch is the Safe's to schedule");

        // The deployer can do nothing more: not a setting, not an upgrade, not through the timelock.
        address nextLogic = address(new BasketVault());
        vm.startPrank(deployer);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, deployer));
        factory.setKeeper(deployer);
        vm.expectRevert();
        beacon.upgradeTo(nextLogic);
        vm.expectRevert();
        timelock.schedule(
            d.factory, 0, abi.encodeCall(IVaultConfig.setKeeper, (deployer)), bytes32(0), bytes32(0), 48 hours
        );
        vm.stopPrank();

        // And the Safe itself waits: 48 hours, not one second less.
        bytes memory call = abi.encodeCall(IVaultConfig.setKeeper, (keeper));
        vm.startPrank(safe);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.NotAdmin.selector, safe));
        factory.setKeeper(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(TimelockController.TimelockInsufficientDelay.selector, 48 hours - 1, 48 hours)
        );
        timelock.schedule(d.factory, 0, call, bytes32(0), bytes32(0), 48 hours - 1);
        timelock.schedule(d.factory, 0, call, bytes32(0), bytes32(0), 48 hours);
        vm.warp(vm.getBlockTimestamp() + 48 hours - 1);
        vm.expectRevert();
        timelock.execute(d.factory, 0, call, bytes32(0), bytes32(0));
        vm.warp(vm.getBlockTimestamp() + 1);
        timelock.execute(d.factory, 0, call, bytes32(0), bytes32(0));
        vm.stopPrank();
        assertEq(factory.keeper(), keeper);
    }

    /// The first thing a person does on it: a vault, a deposit inside the cap, one refused above it, and
    /// everything out again.
    function test_mainnet_aVaultDepositsInsideTheCap_andWithdraws() public {
        Deploy.Deployed memory d = script.deploy(_good(), deployer);
        address person = makeAddr("person");
        Dollar6(USDG).mint(person, 20_000 * USD);
        vm.startPrank(person);
        BasketVault vault = BasketVault(
            payable(VaultFactory(d.factory).createVault(keccak256("plan"), new Weight[](0), bytes32(0), 0, false))
        );
        Dollar6(USDG).approve(address(vault), type(uint256).max);
        vault.deposit(10_000 * USD);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaultConfig.VaultCapReached.selector, address(vault), 10_000 * USD + 1, 10_000 * USD
            )
        );
        vault.deposit(1);
        vault.withdrawAll();
        vm.stopPrank();
        assertEq(Dollar6(USDG).balanceOf(person), 20_000 * USD);
    }

    function test_mainnet_theKeeperFile_insideTheLimits_isAccepted() public {
        Deploy.Deployed memory d = script.deploy(_goodWithKeeper(), deployer);
        assertEq(VaultFactory(d.factory).keeper(), keeper);
        assertEq(VaultFactory(d.factory).asset(address(stock)).flags, 1);
    }

    // ---- every rule, one refusal each

    function test_mainnet_refusesAFileWithAPlaceholder() public {
        Deploy.Config memory cfg = _good();
        cfg.placeholders = true;
        _refused(cfg, "the file still holds a TODO: every value must be confirmed by a person");
    }

    function test_mainnet_refusesTheDeployerAsAdmin() public {
        Deploy.Config memory cfg = _good();
        cfg.adminIsDeployer = true;
        _refused(cfg, "adminIsDeployer: the deployer must end with nothing");
    }

    /// A key as admin, with or without a timelock beside it.
    function test_mainnet_refusesAnAdminThatIsNotTheTimelock() public {
        Deploy.Config memory cfg = _good();
        cfg.admin = makeAddr("a-key");
        _refused(cfg, "admin is set: on a mainnet the admin is the timelock the script creates");
        cfg.timelockOwner = address(0);
        _refused(cfg, "admin is set: on a mainnet the admin is the timelock the script creates");
    }

    function test_mainnet_refusesNoTimelock() public {
        Deploy.Config memory cfg = _good();
        cfg.timelockOwner = address(0);
        _refused(cfg, "no timelock owner");
    }

    /// The owner of the timelock must be a contract: a Safe, not one person's key.
    function test_mainnet_refusesATimelockOwnerWithNoCode() public {
        Deploy.Config memory cfg = _good();
        cfg.timelockOwner = makeAddr("a-key");
        _refused(cfg, "the timelock owner has no code: it must be a contract (a Safe), not a key");
        cfg.timelockOwner = deployer;
        _refused(cfg, "the timelock owner is the deployer");
    }

    function test_mainnet_refusesADelayUnder48Hours_orOver30Days() public {
        Deploy.Config memory cfg = _good();
        cfg.timelockDelay = 48 hours - 1;
        _refused(cfg, "the timelock delay is under 48 hours");
        cfg.timelockDelay = 0;
        _refused(cfg, "the timelock delay is under 48 hours");
        cfg.timelockDelay = 30 days + 1;
        _refused(cfg, "the timelock delay is over 30 days");
    }

    function test_mainnet_refusesNoGuardian_orTheDeployerAsGuardian() public {
        Deploy.Config memory cfg = _good();
        cfg.guardian = address(0);
        _refused(cfg, "no guardian");
        cfg.guardian = deployer;
        _refused(cfg, "the guardian is the deployer");
    }

    function test_mainnet_refusesAShortPublishDelay() public {
        Deploy.Config memory cfg = _good();
        cfg.publishDelay = 300;
        _refused(cfg, "the publish delay is under 172,800 s");
    }

    function test_mainnet_refusesAKeeper_whileTheKeeperIsNotEnabled() public {
        Deploy.Config memory cfg = _good();
        cfg.keeper = keeper;
        _refused(cfg, "a keeper is set while keeperEnabled is false");

        cfg = _goodWithKeeper();
        cfg.keeperEnabled = false;
        cfg.keeper = address(0);
        _refused(cfg, "an asset's keeper switch is on while keeperEnabled is false");
    }

    function test_mainnet_holdsAnEnabledKeeperToAMainnetsLimits() public {
        Deploy.Config memory cfg = _goodWithKeeper();
        cfg.keeper = address(0);
        _refused(cfg, "keeperEnabled with no keeper");
        cfg = _goodWithKeeper();
        cfg.keeper = guardian;
        _refused(cfg, "the keeper is the guardian: the key that stops the keeper must not be the keeper's");
        cfg = _goodWithKeeper();
        cfg.keeper = deployer;
        _refused(cfg, "the keeper is the deployer");
        cfg = _goodWithKeeper();
        cfg.params.toleranceBps = 151;
        _refused(cfg, "toleranceBps is over 150");
        cfg = _goodWithKeeper();
        cfg.params.lossCapBps = 201;
        _refused(cfg, "lossCapBps is over 200");
        cfg = _goodWithKeeper();
        cfg.params.assetCooldown = 3599;
        _refused(cfg, "assetCooldown is under 3,600 s");
        cfg = _goodWithKeeper();
        cfg.priceDevBps = 0;
        _refused(cfg, "priceDevBps is zero or over 200");
        cfg.priceDevBps = 201;
        _refused(cfg, "priceDevBps is zero or over 200");
        cfg = _goodWithKeeper();
        cfg.sessionPriceAge = 0;
        _refused(cfg, "sessionPriceAge is zero with the keeper on for a stock");
        cfg = _goodWithKeeper();
        cfg.assets[1].config.maxPrice = 273e8;
        _refused(cfg, "a keeper asset's price range is wider than about 15% either side");
    }

    function test_mainnet_refusesNoCaps_aZeroCap_andACapOver10000Dollars() public {
        Deploy.Config memory cfg = _good();
        cfg.hasCaps = false;
        _refused(cfg, "no deposit caps");
        cfg = _good();
        cfg.vaultCap = 0;
        _refused(cfg, "a deposit cap of zero");
        cfg = _good();
        cfg.vaultCap = cfg.totalCap + 1;
        _refused(cfg, "the cap of one vault is above the total");
        cfg = _good();
        cfg.totalCap = 10_000 * USD + 1;
        _refused(cfg, "the total cap is over 10,000 dollars before an audit");
    }

    function test_mainnet_refusesAnotherCashToken_aSequencerFeed_andAnotherRouter() public {
        Deploy.Config memory cfg = _good();
        cfg.cashToken = address(0);
        _refused(cfg, "no cash token");
        cfg = _good();
        cfg.cashToken = address(stock);
        _refused(cfg, "the cash token is not Robinhood Chain's USDG");
        cfg = _good();
        cfg.sequencerFeed = address(feed);
        _refused(cfg, "Robinhood Chain has no sequencer feed");
        cfg = _good();
        cfg.routers[0].router = makeAddr("no-code");
        _refused(cfg, "a router has no code");
        cfg = _good();
        cfg.routers[0].router = safe;
        _refused(cfg, "a router that is not Universal Router 2.1.2 through Permit2");
        cfg = _good();
        cfg.routers[0].pull = 1;
        _refused(cfg, "a router that is not Universal Router 2.1.2 through Permit2");
        cfg = _good();
        cfg.assets[0].token = address(new Dollar6());
        _refused(cfg, "the cash token is not among the assets");
    }

    function test_mainnet_holdsEveryAssetToItsTokenAndItsFeed() public {
        Deploy.Config memory cfg = _good();
        cfg.assets[1].token = makeAddr("no-code");
        _refused(cfg, "an asset's token has no code");
        cfg = _good();
        cfg.assets[1].config.tokenDecimals = 8;
        _refused(cfg, "an asset's tokenDecimals are not the token's");
        cfg = _good();
        cfg.assets[1].token = safe;
        _refused(cfg, "an asset's tokenDecimals are not the token's");
        cfg = _good();
        cfg.assets[1].config.pauseProbe = safe;
        _refused(cfg, "an asset's pause probe does not answer");
        cfg = _good();
        cfg.assets[1].config.scheduleSelector = bytes4(keccak256("nothing()"));
        _refused(cfg, "an asset's token does not answer its schedule selector");

        cfg = _good();
        cfg.assets[1].config.feed = makeAddr("no-code");
        _refused(cfg, "an asset's feed has no code");
        cfg = _good();
        cfg.assets[1].config.feedDecimals = 18;
        _refused(cfg, "an asset's feedDecimals are not the feed's");
        cfg = _good();
        cfg.assets[1].config.feed = address(new ChainlinkLikeFeed(8, "RHNVDA / USD", makeAddr("no-code")));
        _refused(cfg, "an asset's feed names no aggregator: not a Chainlink feed");
        cfg = _good();
        cfg.feedDescriptions[1] = "";
        _refused(cfg, "an asset's feedDescription is missing");
        cfg = _good();
        cfg.feedDescriptions[1] = "RHAAPL / USD";
        _refused(cfg, "an asset's feed does not describe itself as the file says");

        cfg = _goodWithKeeper();
        cfg.assets[1].config.averageFeed = makeAddr("no-code");
        _refused(cfg, "an asset's average feed has no code");
        cfg = _goodWithKeeper();
        cfg.assets[1].config.averageFeed = address(new ChainlinkLikeFeed(18, "x", address(0)));
        _refused(cfg, "an average feed's decimals are not the feed's");
        cfg = _good();
        cfg.assets[0].config.flags = 1;
        cfg.keeperEnabled = true;
        cfg.keeper = keeper;
        cfg.priceDevBps = 150;
        _refused(cfg, "an asset with no feed has an average or the keeper's switch");
    }

    // ---- an average feed is held to the asset it is listed for

    /// A pool-average feed built for another token, another feed or another cash token is a wrong paste.
    /// It would list, and the keeper would then refuse the asset with nothing to say why; the script stops.
    function test_mainnet_refusesAnAverageFeedBuiltForAnotherAsset() public {
        address other = address(new Stock18());
        Deploy.Config memory cfg = _goodWithKeeper();
        address wrong = address(new PoolAverageLike(other, USDG, address(feed), 8));
        cfg.assets[1].config.averageFeed = wrong;
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.AverageFeedMismatch.selector, address(stock), wrong, "base() is not the asset's token"
            )
        );
        script.deploy(cfg, deployer);

        wrong = address(new PoolAverageLike(address(stock), USDG, other, 8));
        cfg.assets[1].config.averageFeed = wrong;
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.AverageFeedMismatch.selector, address(stock), wrong, "feed() is not the asset's feed"
            )
        );
        script.deploy(cfg, deployer);

        wrong = address(new PoolAverageLike(address(stock), other, address(feed), 8));
        cfg.assets[1].config.averageFeed = wrong;
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.AverageFeedMismatch.selector, address(stock), wrong, "quote() is not the cash token"
            )
        );
        script.deploy(cfg, deployer);
    }

    /// On a mainnet the average must be a pool-average feed: a contract that does not name its asset, a
    /// Chainlink-style feed included, is not one.
    function test_mainnet_refusesAnAverageFeedThatDoesNotNameItsAsset() public {
        Deploy.Config memory cfg = _goodWithKeeper();
        cfg.assets[1].config.averageFeed = address(new ChainlinkLikeFeed(8, "RHNVDA / USD", address(new Aggregator())));
        _refused(cfg, "an asset's average feed does not name its token, feed and cash: not a pool-average feed");
    }

    /// On a test network the same check runs for a feed that names its asset, and a test price contract,
    /// which names nothing, is listed as before.
    function test_testNetwork_holdsAPoolAverageFeedToItsAsset_andLeavesATestPriceContractAlone() public {
        vm.chainId(31_337);
        Deploy.Config memory cfg = _goodWithKeeper();
        cfg.chainId = 31_337;
        Deploy.Asset memory a = cfg.assets[1];
        assertTrue(script.checkAverageFeed(a, USDG));

        address wrong = address(new PoolAverageLike(address(stock), USDG, address(feed), 18));
        a.config.averageFeed = wrong;
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.AverageFeedMismatch.selector,
                address(stock),
                wrong,
                "decimals() are not the asset's feedDecimals"
            )
        );
        script.checkAverageFeed(a, USDG);
        // The deploy itself stops on it, before the asset is listed.
        cfg.assets[1].config.averageFeed = wrong;
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.AverageFeedMismatch.selector,
                address(stock),
                wrong,
                "decimals() are not the asset's feedDecimals"
            )
        );
        script.deploy(cfg, deployer);

        a.config.averageFeed = address(new TestPriceFeed(8, "tNVDA / USD 1h", address(this), address(this)));
        assertFalse(script.checkAverageFeed(a, USDG));
        a.config.averageFeed = address(0);
        assertFalse(script.checkAverageFeed(a, USDG));
    }

    // ---- no test-only contract can be reached from a mainnet

    /// From the contracts' side: none of them can be created where the chain id is a mainnet's.
    function test_testOnlyContracts_cannotBeCreatedOnAMainnet() public {
        uint256[3] memory mainnets = [uint256(1), 4663, 8453];
        for (uint256 i; i < mainnets.length; ++i) {
            vm.chainId(mainnets[i]);
            bytes memory refused = abi.encodeWithSelector(TestnetOnly.MainnetRefused.selector, mainnets[i]);
            vm.expectRevert(refused);
            new TestPriceFeed(8, "tNVDA / USD", address(this), address(this));
            vm.expectRevert(refused);
            new TestToken("Test USDG", "tUSDG", 6, address(this));
            vm.expectRevert(refused);
            new TestStockToken("Test NVDA", "tNVDA", 18, address(this));
            vm.expectRevert(refused);
            new StubSequencerFeed(address(this), block.timestamp);
            vm.expectRevert(refused);
            new TestMarket(address(this), IPoolManagerLite(address(1)), address(2), 500, 10, 50);
        }
        // And still can on a test network.
        vm.chainId(46_630);
        new TestPriceFeed(8, "tNVDA / USD", address(this), address(this));
        new TestToken("Test USDG", "tUSDG", 6, address(this));
    }

    /// From the file's side: were one to exist at an address a mainnet file names (built from an older
    /// source, say), the script refuses the file. A price one key writes is not a price feed here.
    function test_mainnet_refusesAFileThatNamesATestPriceContract() public {
        vm.chainId(46_630);
        TestPriceFeed testFeed = new TestPriceFeed(8, "RHNVDA / USD", address(this), address(this));
        testFeed.write(230e8, block.timestamp);
        TestPriceFeed testAverage = new TestPriceFeed(8, "RHNVDA / USD", address(this), address(this));
        StubSequencerFeed testSequencer = new StubSequencerFeed(address(this), block.timestamp);
        TestToken testCash = new TestToken("Test USDG", "tUSDG", 6, address(this));
        vm.chainId(ROBINHOOD);

        Deploy.Config memory cfg = _good();
        cfg.assets[1].config.feed = address(testFeed);
        _refused(cfg, "an asset's feed is a test contract: one key writes it");

        cfg = _goodWithKeeper();
        cfg.assets[1].config.averageFeed = address(testAverage);
        _refused(cfg, "an asset's average feed is a test contract: one key writes it");

        // The test cash is not the chain's dollar token, whatever its name.
        cfg = _good();
        cfg.cashToken = address(testCash);
        cfg.assets[0].token = address(testCash);
        _refused(cfg, "the cash token is not Robinhood Chain's USDG");

        // On a mainnet that has a sequencer feed (Base), a stub is refused as one.
        vm.chainId(8453);
        cfg = _good();
        cfg.chainId = 8453;
        cfg.sequencerFeed = address(testSequencer);
        _refused(cfg, "the sequencer feed is a test contract: one key writes it");
    }

    /// From the build's side: the deploy script and the three contracts it deploys are compiled from no
    /// file under `testnet/` or `test/`. The build lists every source that went into each.
    function test_theDeployScriptAndTheContracts_areBuiltFromNoTestOnlySource() public view {
        string[5] memory artifacts = [
            "out/Deploy.s.sol/Deploy.json",
            "out/BasketVault.sol/BasketVault.json",
            "out/VaultFactory.sol/VaultFactory.json",
            "out/IndexRegistry.sol/IndexRegistry.json",
            "out/VaultBeacon.sol/VaultBeacon.json"
        ];
        for (uint256 i; i < artifacts.length; ++i) {
            string[] memory sources = vm.parseJsonKeys(vm.readFile(artifacts[i]), ".metadata.sources");
            assertGt(sources.length, 3, "the build's list of sources was not read");
            for (uint256 j; j < sources.length; ++j) {
                assertEq(vm.indexOf(sources[j], "testnet/"), type(uint256).max, sources[j]);
                assertEq(vm.indexOf(sources[j], "test/"), type(uint256).max, sources[j]);
                assertEq(vm.indexOf(sources[j], "mocks/"), type(uint256).max, sources[j]);
            }
        }
    }

    // ---- the committed mainnet file

    /// As committed it deploys nowhere: it still holds values nobody has confirmed.
    function test_theCommittedMainnetFile_isRefusedWhileItHoldsPlaceholders() public {
        Deploy.Config memory cfg = script.readConfig("script/config/4663.json");
        assertEq(cfg.chainId, ROBINHOOD);
        assertTrue(cfg.placeholders);
        assertFalse(cfg.adminIsDeployer);
        assertFalse(cfg.keeperEnabled);
        assertEq(cfg.keeper, address(0));
        assertEq(cfg.timelockOwner, address(0), "a placeholder");
        assertEq(cfg.guardian, address(0), "a placeholder");
        assertEq(cfg.timelockDelay, 48 hours);
        assertEq(cfg.publishDelay, 172_800);
        assertEq(cfg.cashToken, USDG);
        assertEq(cfg.vaultCap, 10_000 * USD);
        assertEq(cfg.totalCap, 10_000 * USD);
        assertEq(cfg.routers.length, 1);
        assertEq(cfg.routers[0].router, UNIVERSAL_ROUTER);
        for (uint256 i; i < cfg.assets.length; ++i) {
            assertEq(cfg.assets[i].config.flags, 0, "no keeper switch");
            assertEq(cfg.assets[i].config.averageFeed, address(0));
        }
        _refused(cfg, "the file still holds a TODO: every value must be confirmed by a person");

        // Taking the marker out is not enough: the two addresses it stood beside are still missing.
        cfg.placeholders = false;
        _refused(cfg, "no timelock owner");
        cfg.timelockOwner = safe;
        _refused(cfg, "no guardian");
    }

    /// With its placeholders filled, and stand-ins at the addresses it names, the committed file deploys.
    /// The same file against the chain's real token, feed and router is `test/fork/RobinhoodForkDeploy.t.sol`.
    function test_theCommittedMainnetFile_deploysOnceItsPlaceholdersAreFilled() public {
        Deploy.Config memory cfg = script.readConfig("script/config/4663.json");
        cfg.placeholders = false;
        cfg.timelockOwner = safe;
        cfg.guardian = guardian;
        vm.etch(cfg.assets[1].token, address(stock).code);
        vm.etch(cfg.assets[1].config.feed, address(feed).code);
        vm.store(cfg.assets[1].config.feed, bytes32(0), vm.load(address(feed), bytes32(0)));
        vm.store(cfg.assets[1].config.feed, bytes32(uint256(1)), vm.load(address(feed), bytes32(uint256(1))));
        vm.store(cfg.assets[1].config.feed, bytes32(uint256(2)), vm.load(address(feed), bytes32(uint256(2))));
        Deploy.Deployed memory d = script.deploy(cfg, deployer);
        assertEq(VaultFactory(d.factory).admin(), d.timelock);
        assertEq(VaultFactory(d.factory).assets().length, 2);
    }

    // ---- the rest of the script on a mainnet

    function test_mainnet_settingsIsRefused() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.MainnetRefused.selector,
                "settings() is for test networks: on a mainnet the timelock changes settings"
            )
        );
        script.settings();
    }

    function test_isMainnet_isEveryChainButTheKnownTestNetworks() public view {
        assertTrue(script.isMainnet(4663));
        assertTrue(script.isMainnet(8453));
        assertTrue(script.isMainnet(1));
        assertTrue(script.isMainnet(999_999), "a chain nobody listed is treated as real money");
        assertFalse(script.isMainnet(31_337));
        assertFalse(script.isMainnet(46_630));
        assertFalse(script.isMainnet(84_532));
    }

    /// A test network may rehearse the hand-over with a short delay: the 48 hours are a mainnet's rule.
    function test_testNetwork_mayRehearseTheTimelockWithAShortDelay() public {
        vm.chainId(31_337);
        Deploy.Config memory cfg;
        cfg.chainId = 31_337;
        cfg.timelockOwner = makeAddr("a-test-key");
        cfg.timelockDelay = 300;
        cfg.publishDelay = 300;
        cfg.params = Params(125, 200, 50, 3600, 52_200, 72_000);
        Deploy.Deployed memory d = script.deploy(cfg, deployer);
        assertEq(VaultFactory(d.factory).admin(), d.timelock);
        assertEq(TimelockController(payable(d.timelock)).getMinDelay(), 300);
    }

    function test_parseConfig_readsTheMainnetFieldsOfTheExample() public view {
        Deploy.Config memory cfg = script.parseConfig(vm.readFile("script/config/example.json"));
        assertEq(cfg.timelockOwner, address(5));
        assertEq(cfg.timelockDelay, 172_800);
        assertTrue(cfg.keeperEnabled);
        assertTrue(cfg.hasCaps);
        assertEq(cfg.vaultCap, 10_000 * USD);
        assertEq(cfg.totalCap, 10_000 * USD);
        assertEq(cfg.sessionPriceAge, 3600);
        assertEq(cfg.feedDescriptions[1], "EXAMPLE / USD");
        assertFalse(cfg.placeholders);

        // A file without them reads as before: no timelock, no caps, the keeper not declared.
        cfg = script.parseConfig(vm.readFile("script/config/31337.json"));
        assertEq(cfg.timelockOwner, address(0));
        assertFalse(cfg.hasCaps);
        assertFalse(cfg.keeperEnabled);
        assertEq(cfg.sessionPriceAge, 0);
    }
}
