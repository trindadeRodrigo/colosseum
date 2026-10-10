// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {BasketVault} from "../../src/BasketVault.sol";
import {IVaultConfig} from "../../src/interfaces/IVaultConfig.sol";
import {Weight} from "../../src/interfaces/Types.sol";
import {VaultBeacon} from "../../src/VaultBeacon.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";

interface IRealToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// Stands for the Safe: the committed file's one missing contract.
contract SafeStandIn {}

/// The committed mainnet file (`script/config/4663.json`) against Robinhood Chain itself: the real dollar
/// token, the real NVDA token, its real Chainlink feed and the real Universal Router, at the block the
/// other fork tests pin.
///
/// Opt-in, like them: every test here is skipped unless `RH_FORK_URL` is set. It reads a fork and sends
/// nothing to any network.
///
/// What it settles that the unit tests cannot: that the rules of `checkMainnet` pass on the real contracts
/// (the token's own decimals, the feed's own decimals, description and aggregator, the pause and schedule
/// probes), and that the deposit cap and the deposit pause work with the real dollar token.
contract RobinhoodForkDeployTest is Test {
    uint256 internal constant PINNED_BLOCK = 77_417_307;
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
        vm.createSelectFork(url, PINNED_BLOCK);
        script = new Deploy();
        deployer = address(script);
        safe = address(new SafeStandIn());
    }

    /// The committed file with its two missing addresses filled in, and nothing else changed.
    function _file() internal view returns (Deploy.Config memory cfg) {
        cfg = script.readConfig("script/config/4663.json");
        cfg.placeholders = false;
        cfg.timelockOwner = safe;
        cfg.guardian = guardian;
    }

    function test_fork_theChainIsMainnet_andTheCommittedFileIsRefusedAsItStands() public onFork {
        assertEq(block.chainid, 4663);
        Deploy.Config memory cfg = script.readConfig("script/config/4663.json");
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.MainnetRefused.selector, "the file still holds a TODO: every value must be confirmed by a person"
            )
        );
        script.deploy(cfg, deployer);
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
    function test_fork_realDollars_areCappedOnTheWayIn_andNeverOnTheWayOut() public onFork {
        Deploy.Deployed memory d = script.deploy(_file(), deployer);
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
}
