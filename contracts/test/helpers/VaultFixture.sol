// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BasketVault} from "../../src/BasketVault.sol";
import {AssetConfig} from "../../src/interfaces/Types.sol";
import {ConfigHarness} from "./ConfigHarness.sol";

/// Deploys what a chain has: one config, one vault logic contract, one beacon, and vaults as beacon proxies
/// created with their init call inside the constructor. The factory of EVM-2 replaces `_createVault`.
abstract contract VaultFixture is Test {
    bytes32 internal constant PLAN_ID = keccak256("plan-1");

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal feed = makeAddr("feed");

    ConfigHarness internal config;
    BasketVault internal logic;
    UpgradeableBeacon internal beacon;
    BasketVault internal vault;

    function _deployPlatform() internal {
        config = new ConfigHarness(admin);
        logic = new BasketVault();
        beacon = new UpgradeableBeacon(address(logic), admin);
        vault = _createVault(owner, PLAN_ID);
    }

    function _createVault(address owner_, bytes32 planId_) internal returns (BasketVault) {
        return _createVault(owner_, planId_, address(config));
    }

    function _createVault(address owner_, bytes32 planId_, address config_) internal returns (BasketVault) {
        bytes memory init = abi.encodeCall(BasketVault.initialize, (owner_, planId_, config_));
        return BasketVault(address(new BeaconProxy(address(beacon), init)));
    }

    /// A priced asset as the platform would list it: a Chainlink-style feed with 8 decimals, 26 hours of age.
    function _assetConfig(uint8 tokenDecimals) internal view returns (AssetConfig memory) {
        return AssetConfig({
            feed: feed,
            tokenDecimals: tokenDecimals,
            feedDecimals: 8,
            maxAge: 26 hours,
            session: 1,
            source: 1,
            maxWeightBps: 5000,
            pauseProbe: address(0),
            pauseSelector: bytes4(0),
            scheduleSelector: bytes4(0),
            haltUntil: 0
        });
    }

    function _list(address token, uint8 tokenDecimals) internal {
        vm.prank(admin);
        config.setAsset(token, _assetConfig(tokenDecimals));
    }

    /// Makes a listed token the chain's cash token: the one token `deposit` pulls.
    function _setCash(address token) internal {
        vm.prank(admin);
        config.setCashToken(token);
    }

    /// Deposits `token` into `vault_` as its owner, by making it the cash token for the length of the call.
    /// This is how a test gets several tokens into a vault's `tokens` list before the swaps exist.
    function _depositAs(BasketVault vault_, address token, uint256 amount) internal {
        address cashBefore = config.cashToken();
        if (cashBefore != token) _setCash(token);
        vm.prank(vault_.owner());
        vault_.deposit(amount);
        if (cashBefore != token && cashBefore != address(0)) _setCash(cashBefore);
    }
}
