// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {BasketVault} from "../../src/BasketVault.sol";
import {IVaultConfig} from "../../src/interfaces/IVaultConfig.sol";
import {IBasketVault} from "../../src/interfaces/IBasketVault.sol";
import {IPermit2} from "../../src/interfaces/IPermit2.sol";
import {Swap, Weight} from "../../src/interfaces/Types.sol";
import {VaultBeacon} from "../../src/VaultBeacon.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {ForkBlock} from "./ForkBlock.sol";
import {UniV4Calldata} from "./UniV4Calldata.sol";

interface IRealFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IRealToken {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface ISafe {
    function VERSION() external view returns (string memory);
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);
}

/// Stands for the Safe where a test does not need the real one: two of three must sign.
contract SafeStandIn {
    function getThreshold() external pure returns (uint256) {
        return 2;
    }

    function getOwners() external pure returns (address[] memory owners) {
        owners = new address[](3);
        owners[0] = address(0x5AFE01);
        owners[1] = address(0x5AFE02);
        owners[2] = address(0x5AFE03);
    }

    function getModulesPaginated(address, uint256) external pure returns (address[] memory array, address next) {
        return (array, address(1));
    }
}

/// The committed mainnet file (`script/config/4663.json`) against Robinhood Chain itself: the real dollar
/// token, every stock token the file lists with its real Chainlink feed, and the real Universal Router, at
/// the block the other fork tests read (`ForkBlock`).
///
/// Opt-in, like them: every test here is skipped unless `RH_FORK_URL` is set. It reads a fork and sends
/// nothing to any network.
///
/// What it settles that the unit tests cannot: that the rules of `checkMainnet` pass on the real contracts
/// (the token's own decimals, the feed's own decimals, description and aggregator, the pause and schedule
/// probes), that the deposit cap and the deposit pause work with the real dollar token, and that a vault
/// deposits, trades into and out of, and withdraws EVERY listed token through the one pool the file
/// records for it.
contract RobinhoodForkDeployTest is Test {
    using stdJson for string;

    address internal constant REAL_SAFE = 0x4568Bc6Cc821B34095059Fd46102eAA22A675Fdc;
    address internal constant UNIVERSAL_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    /// What a person puts in for each token, and how much of it is traded into the token.
    uint256 internal constant ROUND_TRIP_DEPOSIT = 1000 * USD;
    uint256 internal constant ROUND_TRIP_TRADE = 500 * USD;
    /// A fill may be this far from the Chainlink price, pool fee included: 2%.
    uint256 internal constant MAX_COST_BPS = 200;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant USDG_HOLDER = 0xfbcC34e25937282a3D0FbDE054A9A49E9968c51A;
    address internal constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address internal constant NVDA_HOLDER = 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3;
    uint256 internal constant USD = 1e6;

    bool internal forked;
    Deploy internal script;
    address internal deployer;
    address internal safe;
    address internal guardian = makeAddr("guardian");
    address internal person = makeAddr("person");

    modifier onFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function setUp() public {
        string memory url = vm.envOr("RH_FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        forked = true;
        vm.createSelectFork(url, ForkBlock.number());
        script = new Deploy();
        deployer = address(script);
        safe = address(new SafeStandIn());
    }

    /// The committed file with a stand-in for the Safe and one for the missing guardian, and nothing else
    /// changed. The stand-in Safe keeps these tests independent of the block the real one was created in.
    function _file() internal view returns (Deploy.Config memory cfg) {
        cfg = script.readConfig("script/config/4663.json");
        cfg.placeholders = false;
        cfg.timelockOwner = safe;
        cfg.guardian = guardian;
    }

    /// The Safe the committed file names (created 2026-10-12, block 86,734,497), as it is on the chain: Safe
    /// 1.5.0, two owners, two signatures, no module. `checkSafe` passes on it, and the file deploys with it as
    /// the timelock's only proposer, canceller and executor, and with the guardian the file names: nothing
    /// in this test stands in for anything.
    ///
    /// Safe 1.5.0 has no `getModules()` of its own (it left the contract after 1.2.0); this one answers it
    /// through its fallback handler. The paged list is the Safe's own answer, and `checkSafe` needs only one.
    function test_fork_theRealSafe_passesCheckSafe_andTheFileDeploysWithItAsTheTimelocksOwner() public onFork {
        Deploy.Config memory cfg = script.readConfig("script/config/4663.json");
        assertEq(cfg.timelockOwner, REAL_SAFE, "the file names the Safe");
        assertGt(REAL_SAFE.code.length, 0, "the Safe exists at this block: RH_FORK_BLOCK is 86,734,497 or later");
        assertEq(ISafe(REAL_SAFE).VERSION(), "1.5.0");

        (uint256 threshold, address[] memory owners) = script.checkSafe(REAL_SAFE, cfg.safeMinThreshold);
        assertEq(threshold, 2);
        assertEq(owners.length, 2);
        assertEq(owners[0], 0x0a1c3312c808b23D019bF241028f6B5624f4cc98);
        assertEq(owners[1], 0xAC3cBBCd6e51dBFAf4e79d5E8Cf54a1622D71e0e);
        (address[] memory modules, address next) = ISafe(REAL_SAFE).getModulesPaginated(address(1), 10);
        assertEq(modules.length, 0, "no module is enabled");
        assertEq(next, address(1), "and the list ends there");
        // A threshold of three is more than this Safe needs: the same check refuses it by name.
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.MainnetRefused.selector, "the Safe needs fewer signatures than safeMinThreshold"
            )
        );
        script.checkSafe(REAL_SAFE, 3);

        // The guardian the file names is one of the Safe's two owners (a person's decision): the script
        // takes it, and still refuses the deployer as guardian.
        assertEq(cfg.guardian, owners[0], "the guardian is the Safe's first owner");
        cfg.placeholders = false;
        Deploy.Config memory self = script.readConfig("script/config/4663.json");
        self.placeholders = false;
        self.guardian = deployer;
        vm.expectRevert(abi.encodeWithSelector(Deploy.MainnetRefused.selector, "the guardian is the deployer"));
        script.deploy(self, deployer);

        Deploy.Deployed memory d = script.deploy(cfg, deployer);
        TimelockController timelock = TimelockController(payable(d.timelock));
        assertEq(VaultFactory(d.factory).guardian(), 0x0a1c3312c808b23D019bF241028f6B5624f4cc98);
        assertEq(VaultFactory(d.factory).admin(), d.timelock);
        assertEq(VaultBeacon(d.beacon).owner(), d.timelock);
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), REAL_SAFE));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), REAL_SAFE));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), REAL_SAFE));
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), deployer));
        assertFalse(timelock.hasRole(timelock.EXECUTOR_ROLE(), deployer));
        assertEq(timelock.getMinDelay(), 48 hours);
    }

    /// The committed file as it stands, nothing filled in and nothing stood in for: every value in it is
    /// confirmed (Thom, 2026-10-12), so it passes every mainnet rule against the real chain and deploys,
    /// the real Safe behind the timelock and the guardian it names. With the marker word put back into
    /// it, it is refused as before: the rule is not gone, the file no longer trips it.
    function test_fork_theChainIsMainnet_andTheCommittedFileDeploysAsItStands() public onFork {
        assertEq(block.chainid, 4663);
        Deploy.Config memory cfg = script.readConfig("script/config/4663.json");
        assertFalse(cfg.placeholders, "no value is left unconfirmed");
        Deploy.Config memory marked = script.readConfig("script/config/4663.json");
        marked.placeholders = true;
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.MainnetRefused.selector, "the file still holds a TODO: every value must be confirmed by a person"
            )
        );
        script.deploy(marked, deployer);

        Deploy.Deployed memory d = script.deploy(cfg, deployer);
        VaultFactory factory = VaultFactory(d.factory);
        assertEq(factory.admin(), d.timelock);
        assertEq(factory.guardian(), cfg.guardian);
        assertEq(factory.assets().length, cfg.assets.length);
        assertTrue(TimelockController(payable(d.timelock)).hasRole(keccak256("PROPOSER_ROLE"), REAL_SAFE));
        // The ceilings a shared portfolio is held to, as confirmed.
        assertEq(factory.asset(NVDA).maxWeightBps, 2500);
        for (uint256 i = 1; i < cfg.assets.length; ++i) {
            assertEq(factory.asset(cfg.assets[i].token).maxWeightBps, cfg.assets[i].config.maxWeightBps);
            assertGt(cfg.assets[i].config.maxWeightBps, 0);
        }
    }

    /// Every rule passes on the real token, feed and router, and the run ends with the timelock holding
    /// both keys.
    function test_fork_theCommittedFile_deploysAgainstTheRealContracts() public onFork {
        Deploy.Config memory cfg = _file();
        Deploy.Deployed memory d = script.deploy(cfg, deployer);
        VaultFactory factory = VaultFactory(d.factory);
        TimelockController timelock = TimelockController(payable(d.timelock));

        assertEq(factory.admin(), d.timelock);
        assertEq(VaultBeacon(d.beacon).owner(), d.timelock);
        assertEq(timelock.getMinDelay(), 48 hours);
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), deployer));
        assertFalse(timelock.hasRole(timelock.EXECUTOR_ROLE(), deployer));
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), safe));
        assertEq(factory.cashToken(), USDG);
        assertTrue(factory.isAsset(NVDA));
        assertEq(factory.asset(NVDA).tokenDecimals, 18);
        assertEq(factory.asset(NVDA).feedDecimals, 8);
        assertEq(factory.asset(NVDA).flags, 0, "owner-signed only: no keeper switch");
        assertEq(factory.keeper(), address(0));
        assertEq(factory.guardian(), guardian);
    }

    /// As committed, with no cap: real dollars come in far past 10,000 and go out again.
    function test_fork_theCommittedFile_takesRealDollarsWithNoCap() public onFork {
        Deploy.Deployed memory d = script.deploy(_file(), deployer);
        VaultFactory factory = VaultFactory(d.factory);
        (uint256 perVault, uint256 total) = factory.depositCaps();
        assertEq(perVault + total, 0, "no cap");
        vm.prank(USDG_HOLDER);
        assertTrue(IRealToken(USDG).transfer(person, 250_000 * USD));
        vm.startPrank(person);
        BasketVault vault =
            BasketVault(payable(factory.createVault(keccak256("plan"), new Weight[](0), bytes32(0), 0, false)));
        IRealToken(USDG).approve(address(vault), type(uint256).max);
        vault.deposit(250_000 * USD);
        vault.withdrawAll();
        vm.stopPrank();
        assertEq(IRealToken(USDG).balanceOf(person), 250_000 * USD);
    }

    /// A wrong number of decimals for the real token, or another feed's description, is caught against the
    /// chain and not only against a stand-in.
    function test_fork_theRealTokenAndFeed_refuseWrongDecimalsAndAWrongDescription() public onFork {
        Deploy.Config memory cfg = _file();
        cfg.assets[1].config.tokenDecimals = 6;
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.MainnetRefused.selector, "an asset's tokenDecimals are not the token's")
        );
        script.deploy(cfg, deployer);

        cfg = _file();
        cfg.assets[1].config.feedDecimals = 18;
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.MainnetRefused.selector, "an asset's feedDecimals are not the feed's")
        );
        script.deploy(cfg, deployer);

        cfg = _file();
        cfg.feedDescriptions[1] = "RHAAPL / USD";
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.MainnetRefused.selector, "an asset's feed does not describe itself as the file says"
            )
        );
        script.deploy(cfg, deployer);
    }

    /// The cap, the pause and the way out, with the real dollar token and the real stock token.
    /// The committed file sets no cap; this one adds a cap of 10,000 dollars to it, to see a cap bite on
    /// the real token.
    function test_fork_realDollars_areCappedOnTheWayIn_andNeverOnTheWayOut() public onFork {
        Deploy.Config memory capped = _file();
        capped.hasCaps = true;
        capped.vaultCap = 10_000 * USD;
        capped.totalCap = 10_000 * USD;
        Deploy.Deployed memory d = script.deploy(capped, deployer);
        VaultFactory factory = VaultFactory(d.factory);
        vm.prank(USDG_HOLDER);
        assertTrue(IRealToken(USDG).transfer(person, 12_000 * USD));

        vm.startPrank(person);
        BasketVault vault =
            BasketVault(payable(factory.createVault(keccak256("plan"), new Weight[](0), bytes32(0), 0, false)));
        IRealToken(USDG).approve(address(vault), type(uint256).max);
        vault.deposit(10_000 * USD);
        vm.expectRevert(
            abi.encodeWithSelector(
                IVaultConfig.VaultCapReached.selector, address(vault), 10_000 * USD + 1, 10_000 * USD
            )
        );
        vault.deposit(1);
        vm.stopPrank();
        assertEq(vault.netDeposited(), 10_000 * USD);
        assertEq(factory.totalDeposited(), 10_000 * USD);

        // The real stock token, sent in from outside and taken out in kind while everything is stopped.
        vm.prank(NVDA_HOLDER);
        assertTrue(IRealToken(NVDA).transfer(address(vault), 0.05e18));
        vm.startPrank(guardian);
        factory.pauseDeposits();
        factory.pauseKeeper();
        vm.stopPrank();

        vm.startPrank(person);
        vault.withdraw(USDG, 4000 * USD);
        vm.expectRevert(IVaultConfig.DepositsArePaused.selector);
        vault.deposit(1000 * USD);
        vault.withdraw(NVDA, 0.05e18);
        vault.withdrawAll();
        vm.stopPrank();
        assertEq(IRealToken(USDG).balanceOf(person), 12_000 * USD);
        assertEq(IRealToken(NVDA).balanceOf(person), 0.05e18);
        assertEq(IRealToken(USDG).balanceOf(address(vault)), 0);
        assertEq(vault.netDeposited(), 0);
    }

    // ---- every listed token, through its own pool

    /// The pool the file records for the asset at `index`: hookless, against the dollar token.
    function _poolOf(string memory json, uint256 index, address token)
        internal
        pure
        returns (UniV4Calldata.PoolKey memory)
    {
        string memory at = string.concat(".assets[", vm.toString(index), "].pool");
        uint24 fee = uint24(json.readUint(string.concat(at, ".fee")));
        int24 tickSpacing = int24(int256(json.readUint(string.concat(at, ".tickSpacing"))));
        (address currency0, address currency1) = token < USDG ? (token, USDG) : (USDG, token);
        return UniV4Calldata.PoolKey(currency0, currency1, fee, tickSpacing, address(0));
    }

    function _assertNothingApproved(address vault_, address token) internal view {
        assertEq(IRealToken(token).allowance(vault_, PERMIT2), 0, "the token's allowance to Permit2");
        assertEq(IRealToken(token).allowance(vault_, UNIVERSAL_ROUTER), 0, "the token's allowance to the router");
        (uint160 inPermit2,,) = IPermit2(PERMIT2).allowance(vault_, token, UNIVERSAL_ROUTER);
        assertEq(inPermit2, 0, "the allowance inside Permit2");
    }

    function _one(Swap memory s) internal pure returns (Swap[] memory list) {
        list = new Swap[](1);
        list[0] = s;
    }

    /// The file lists more than NVDA, and every stock token states the pool its trades go through.
    function test_fork_everyListedToken_statesItsPool() public onFork {
        Deploy.Config memory cfg = script.readConfig("script/config/4663.json");
        string memory json = vm.readFile("script/config/4663.json");
        assertEq(cfg.assets[0].token, USDG, "the cash is first");
        assertFalse(vm.keyExistsJson(json, ".assets[0].pool"), "the cash has no pool");
        assertGt(cfg.assets.length, 2, "more than NVDA is listed");
        for (uint256 i = 1; i < cfg.assets.length; ++i) {
            UniV4Calldata.PoolKey memory key = _poolOf(json, i, cfg.assets[i].token);
            assertLe(key.fee, 1_000_000, "a fee Uniswap v4 allows");
            assertGt(key.tickSpacing, 0, "a tick spacing above zero");
        }
    }

    /// For every token the committed file lists: a person opens a vault with the token as its target, puts
    /// real dollars in, trades half of them into the token through the pool the file records for it, sells
    /// half of that back through the same pool, and takes everything out, token and dollars. Each fill is
    /// held to the token's own Chainlink price less `MAX_COST_BPS`. A token whose recorded pool does not
    /// exist, holds nothing, or prices far from its feed fails here, by name.
    function test_fork_everyListedToken_deposits_tradesInItsOwnPool_andWithdraws() public onFork {
        Deploy.Config memory cfg = _file();
        Deploy.Deployed memory d = script.deploy(cfg, deployer);
        VaultFactory factory = VaultFactory(d.factory);
        string memory json = vm.readFile("script/config/4663.json");
        uint256 listed = cfg.assets.length - 1;
        vm.prank(USDG_HOLDER);
        assertTrue(IRealToken(USDG).transfer(person, listed * ROUND_TRIP_DEPOSIT));

        for (uint256 i = 1; i < cfg.assets.length; ++i) {
            _roundTrip(factory, cfg.assets[i].token, cfg.assets[i].config.feed, _poolOf(json, i, cfg.assets[i].token));
        }
    }

    function _roundTrip(VaultFactory factory, address token, address feed, UniV4Calldata.PoolKey memory key) internal {
        string memory name = vm.toString(token);
        assertTrue(factory.isAsset(token), name);
        (, int256 answer,,,) = IRealFeed(feed).latestRoundData();
        uint256 price = uint256(answer);
        assertGt(price, 0, name);
        uint256 dollarsBefore = IRealToken(USDG).balanceOf(person);
        uint256 tokensBefore = IRealToken(token).balanceOf(person);

        Weight[] memory targets = new Weight[](1);
        targets[0] = Weight(token, 5000);
        vm.startPrank(person);
        BasketVault vault =
            BasketVault(payable(factory.createVault(bytes32(uint256(uint160(token))), targets, bytes32(0), 0, false)));
        IRealToken(USDG).approve(address(vault), ROUND_TRIP_DEPOSIT);
        vault.deposit(ROUND_TRIP_DEPOSIT);

        // In: dollars for the token. 6 decimals in, 18 out, the feed at 8: tokens = dollars * 1e20 / price.
        uint256 fair = ROUND_TRIP_TRADE * 1e20 / price;
        uint256 minOut = fair * (10_000 - MAX_COST_BPS) / 10_000;
        vault.ownerSwap(
            _one(
                Swap({
                    router: UNIVERSAL_ROUTER,
                    tokenIn: USDG,
                    tokenOut: token,
                    amountIn: ROUND_TRIP_TRADE,
                    minOut: minOut,
                    data: UniV4Calldata.exactInSingle(
                        key, USDG, ROUND_TRIP_TRADE, minOut, address(0), block.timestamp + 300
                    )
                })
            ),
            type(uint64).max
        );
        uint256 bought = IRealToken(token).balanceOf(address(vault));
        assertGe(bought, minOut, string.concat(name, ": at least the minimum arrived"));
        assertLe(bought, fair * (10_000 + MAX_COST_BPS) / 10_000, string.concat(name, ": and no windfall either"));
        assertEq(
            IRealToken(USDG).balanceOf(address(vault)),
            ROUND_TRIP_DEPOSIT - ROUND_TRIP_TRADE,
            "exactly the trade was spent"
        );
        assertEq(vault.tokens().length, 2, name);
        _assertNothingApproved(address(vault), USDG);

        // Out: half of the token back for dollars, through the same pool.
        uint256 sold = bought / 2;
        uint256 minDollars = sold * price / 1e20 * (10_000 - MAX_COST_BPS) / 10_000;
        vault.ownerSwap(
            _one(
                Swap({
                    router: UNIVERSAL_ROUTER,
                    tokenIn: token,
                    tokenOut: USDG,
                    amountIn: sold,
                    minOut: minDollars,
                    data: UniV4Calldata.exactInSingle(key, token, sold, minDollars, address(0), block.timestamp + 300)
                })
            ),
            type(uint64).max
        );
        uint256 dollarsInVault = IRealToken(USDG).balanceOf(address(vault));
        assertGe(
            dollarsInVault, ROUND_TRIP_DEPOSIT - ROUND_TRIP_TRADE + minDollars, string.concat(name, ": the sale paid")
        );
        assertEq(IRealToken(token).balanceOf(address(vault)), bought - sold, name);
        _assertNothingApproved(address(vault), token);

        // The way out: the token in kind and the dollars, to the person, and the vault holds nothing.
        assertEq(vault.withdrawAll().length, 0, string.concat(name, ": nothing was left behind"));
        vm.stopPrank();
        assertEq(IRealToken(token).balanceOf(person), tokensBefore + bought - sold, name);
        assertEq(IRealToken(USDG).balanceOf(person), dollarsBefore - ROUND_TRIP_DEPOSIT + dollarsInVault, name);
        assertEq(IRealToken(token).balanceOf(address(vault)), 0, name);
        assertEq(IRealToken(USDG).balanceOf(address(vault)), 0, name);
        assertEq(vault.netDeposited(), 0, name);
        // The round trip cost the person at most the bound, twice over, on the half that was traded.
        assertGe(
            dollarsInVault + (bought - sold) * price / 1e20,
            ROUND_TRIP_DEPOSIT - ROUND_TRIP_TRADE * 2 * MAX_COST_BPS / 10_000,
            string.concat(name, ": what came out is worth what went in, less the bound")
        );
    }

    /// A trade through a pool shape nobody opened for the two tokens does not fill: the router fails, the
    /// vault's dollars stay where they were and nothing is left approved. The guard refuses such a route
    /// before a person signs (packages/sdk); this is what the chain does with it.
    function test_fork_aTradeThroughAPoolThatDoesNotExist_movesNothing() public onFork {
        Deploy.Config memory cfg = _file();
        Deploy.Deployed memory d = script.deploy(cfg, deployer);
        VaultFactory factory = VaultFactory(d.factory);
        vm.prank(USDG_HOLDER);
        assertTrue(IRealToken(USDG).transfer(person, ROUND_TRIP_DEPOSIT));
        address token = cfg.assets[1].token;
        (, int256 answer,,,) = IRealFeed(cfg.assets[1].config.feed).latestRoundData();
        uint256 minOut = ROUND_TRIP_TRADE * 1e20 / uint256(answer) * (10_000 - MAX_COST_BPS) / 10_000;
        // A shape nobody opened a pool at for these two tokens.
        (address currency0, address currency1) = token < USDG ? (token, USDG) : (USDG, token);
        UniV4Calldata.PoolKey memory nowhere = UniV4Calldata.PoolKey(currency0, currency1, 123, 7, address(0));

        vm.startPrank(person);
        BasketVault vault =
            BasketVault(payable(factory.createVault(keccak256("plan"), new Weight[](0), bytes32(0), 0, false)));
        IRealToken(USDG).approve(address(vault), ROUND_TRIP_DEPOSIT);
        vault.deposit(ROUND_TRIP_DEPOSIT);
        vm.expectPartialRevert(IBasketVault.RouterFailed.selector);
        vault.ownerSwap(
            _one(
                Swap({
                    router: UNIVERSAL_ROUTER,
                    tokenIn: USDG,
                    tokenOut: token,
                    amountIn: ROUND_TRIP_TRADE,
                    minOut: minOut,
                    data: UniV4Calldata.exactInSingle(
                        nowhere, USDG, ROUND_TRIP_TRADE, minOut, address(0), block.timestamp + 300
                    )
                })
            ),
            type(uint64).max
        );
        vm.stopPrank();
        assertEq(IRealToken(USDG).balanceOf(address(vault)), ROUND_TRIP_DEPOSIT);
        _assertNothingApproved(address(vault), USDG);
    }
}
