// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {BasketVault} from "../../src/BasketVault.sol";
import {IndexRegistry} from "../../src/IndexRegistry.sol";
import {PERMIT2} from "../../src/interfaces/IVaultConfig.sol";
import {AssetConfig, Params, Swap, Weight} from "../../src/interfaces/Types.sol";
import {VaultBeacon} from "../../src/VaultBeacon.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {MockPermit2} from "../mocks/Routers.sol";

/// Deploys what a chain has: the vault logic and its beacon, the factory and the registry behind their
/// proxies, and one vault created through the factory as any vault is.
abstract contract VaultFixture is Test {
    bytes32 internal constant PLAN_ID = keccak256("plan-1");
    /// The team's test cycle (gate AUTO-FOLLOW): before `launch()` a later version waits 300 s.
    uint32 internal constant PUBLISH_DELAY = 300;

    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal feed = makeAddr("feed");

    /// The factory is also the config every vault reads.
    VaultFactory internal factory;
    IndexRegistry internal registry;
    BasketVault internal logic;
    VaultBeacon internal beacon;
    BasketVault internal vault;

    function _deployPlatform() internal {
        // On a fork the real Permit2 is already there.
        if (PERMIT2.code.length == 0) vm.etch(PERMIT2, address(new MockPermit2()).code);
        logic = new BasketVault();
        beacon = new VaultBeacon(address(logic), admin);
        factory = _newFactory();
        registry = _newRegistry(factory);
        vm.startPrank(admin);
        factory.setRegistry(address(registry));
        factory.setGuardian(guardian);
        factory.setKeeper(keeper);
        vm.stopPrank();
        vault = _createVault(owner, PLAN_ID);
    }

    /// The design's starting values (section 5): 125 bps a trade, 200 bps a week, a 50 bps band, an hour
    /// between two keeper trades in an asset, Monday to Friday 14:30 to 20:00 UTC.
    function _params() internal pure returns (Params memory) {
        return Params({
            toleranceBps: 125,
            lossCapBps: 200,
            bandBps: 50,
            assetCooldown: 3600,
            sessionOpen: 52_200,
            sessionClose: 72_000
        });
    }

    /// Another factory on the same beacon, with nothing listed.
    function _newFactory() internal returns (VaultFactory) {
        bytes memory init = abi.encodeCall(VaultFactory.initialize, (admin, address(beacon), _params()));
        return VaultFactory(address(new ERC1967Proxy(address(new VaultFactory()), init)));
    }

    function _newRegistry(VaultFactory factory_) internal returns (IndexRegistry) {
        bytes memory init = abi.encodeCall(IndexRegistry.initialize, (address(factory_), PUBLISH_DELAY));
        return IndexRegistry(address(new ERC1967Proxy(address(new IndexRegistry()), init)));
    }

    /// A vault with no targets, created as its owner would.
    function _createVault(address owner_, bytes32 planId_) internal returns (BasketVault) {
        return _createVault(factory, owner_, planId_);
    }

    function _createVault(VaultFactory factory_, address owner_, bytes32 planId_) internal returns (BasketVault) {
        vm.prank(owner_);
        return BasketVault(factory_.createVault(planId_, new Weight[](0), bytes32(0), 0, false));
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
        factory.setAsset(token, _assetConfig(tokenDecimals));
    }

    /// Makes a listed token the chain's cash token: the one token `deposit` pulls.
    function _setCash(address token) internal {
        vm.prank(admin);
        factory.setCashToken(token);
    }

    /// Deposits `token` into `vault_` as its owner, by making it the cash token for the length of the call.
    /// A test that wants a token in a vault's `tokens` list without a swap uses this.
    function _depositAs(BasketVault vault_, address token, uint256 amount) internal {
        address cashBefore = factory.cashToken();
        if (cashBefore != token) _setCash(token);
        vm.prank(vault_.owner());
        vault_.deposit(amount);
        if (cashBefore != token && cashBefore != address(0)) _setCash(cashBefore);
    }

    function _swaps(Swap memory s) internal pure returns (Swap[] memory list) {
        list = new Swap[](1);
        list[0] = s;
    }
}
