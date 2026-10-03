// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {BasketVault} from "../src/BasketVault.sol";
import {Weight} from "../src/interfaces/Types.sol";
import {SwapFixture} from "./helpers/SwapFixture.sol";

/// Where each contract keeps its state. The three contracts behind proxies each use one ERC-7201 namespace,
/// and a later version may only add fields after the ones pinned here. A test fails when a field moves, so
/// an upgrade that would read old state at the wrong place is caught before it is deployed.
contract StorageLayoutTest is SwapFixture {
    bytes32 internal constant FAMILY = keccak256("family");
    bytes32 internal constant META = keccak256("meta");
    bytes32 internal id;
    BasketVault internal follower;

    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function setUp() public {
        _deploySwapPlatform();
        vm.warp(1_791_212_400);
        vm.prank(stranger);
        id = registry.create(FAMILY, _threeStocks(), META, 0, 0);
        vm.startPrank(owner);
        follower = BasketVault(payable(factory.createVault(keccak256("plan-follow"), new Weight[](0), id, 1, false)));
        cash.approve(address(follower), 10 * USD);
        follower.deposit(10 * USD);
        vm.stopPrank();
    }

    function _namespace(string memory name) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(uint256(keccak256(bytes(name))) - 1)) & ~bytes32(uint256(0xff)));
    }

    function _word(address where, uint256 slot) internal view returns (uint256) {
        return uint256(vm.load(where, bytes32(slot)));
    }

    function _addr(address where, uint256 slot) internal view returns (address) {
        return address(uint160(_word(where, slot)));
    }

    /// Nothing sits in the plain slots, where a base contract added later would put its state.
    function _assertPlainSlotsEmpty(address where) internal view {
        for (uint256 i; i < 16; ++i) {
            assertEq(_word(where, i), 0);
        }
    }

    function test_storage_ofAVault() public view {
        uint256 s = _namespace("basket.storage.BasketVault");
        address where = address(follower);
        // EVM-1
        assertEq(_addr(where, s), owner, "owner");
        assertEq(_addr(where, s + 1), address(factory), "config");
        assertEq(_word(where, s + 2), uint256(keccak256("plan-follow")), "planId");
        assertEq(_word(where, s + 3), 1, "tokens: the list's length");
        assertEq(_addr(where, uint256(keccak256(abi.encode(s + 3)))), address(cash), "tokens: the first entry");
        assertEq(_word(where, uint256(keccak256(abi.encode(address(cash), s + 4)))), 1, "tokens: the position map");
        // EVM-2, appended
        assertEq(_word(where, s + 5), uint256(id), "indexId");
        assertEq(_word(where, s + 6), 1, "acceptedVersion, then autoFollow and operator, both unset");
        assertEq(_word(where, s + 7), 3, "targets: the list's length");
        Weight[] memory targets = _threeStocks();
        uint256 first = _word(where, uint256(keccak256(abi.encode(s + 7))));
        assertEq(address(uint160(first)), targets[0].token, "targets: a token");
        assertEq(uint16(first >> 160), targets[0].bps, "targets: its weight, in the same slot");
        assertEq(_word(where, s + 8), 0, "the next field a later version adds goes here");
        _assertPlainSlotsEmpty(where);
    }

    /// `autoFollow` and `operator` share a slot with `acceptedVersion`. Nothing sets them yet, so their
    /// places are shown by writing the slot and reading it back through the vault.
    function test_storage_ofAVault_theSlotAutoFollowSharesWithTheVersion() public {
        uint256 s = _namespace("basket.storage.BasketVault");
        vm.store(address(follower), bytes32(s + 6), bytes32((uint256(1) << 32) | 7));
        (, uint32 version, bool autoFollow) = follower.following();
        assertEq(version, 7);
        assertTrue(autoFollow);
    }

    function test_storage_ofTheFactory_theConfigNamespace() public {
        vm.startPrank(admin);
        factory.proposeAdmin(stranger);
        factory.removeAsset(address(stockC));
        factory.setSequencerFeed(feed);
        factory.launch();
        vm.stopPrank();
        vm.startPrank(guardian);
        factory.pauseKeeper();
        factory.extendClosedUntil(1_800_000_000);
        factory.addClosedDay(20_800);
        vm.stopPrank();

        uint256 s = _namespace("basket.storage.VaultConfig");
        address where = address(factory);
        // EVM-1
        assertEq(_addr(where, s), admin, "admin");
        assertEq(_addr(where, s + 1), stranger, "pendingAdmin");
        assertEq(_word(where, s + 2), 3, "assetList: the list's length");
        assertEq(
            _addr(where, uint256(keccak256(abi.encode(address(stockA), s + 4)))), feed, "assets: an asset's feed first"
        );
        assertEq(_word(where, uint256(keccak256(abi.encode(address(direct), s + 5)))), 1, "routerPull");
        assertEq(_addr(where, s + 6), address(cash), "cashToken");
        // EVM-2, appended
        assertEq(_word(where, s + 7), 1, "removed: the list's length");
        uint256 packed = _word(where, s + 9);
        assertEq(address(uint160(packed)), guardian, "guardian");
        assertEq(uint8(packed >> 160), 1, "keeperPaused");
        assertEq(uint8(packed >> 168), 1, "launched");
        assertEq(uint64(packed >> 176), 1_800_000_000, "closedUntil");
        assertEq(_addr(where, s + 10), keeper, "keeper");
        uint256 params = _word(where, s + 11);
        assertEq(uint16(params), 125, "params.toleranceBps");
        assertEq(uint16(params >> 16), 200, "params.lossCapBps");
        assertEq(uint16(params >> 32), 50, "params.bandBps");
        assertEq(uint32(params >> 48), 3600, "params.assetCooldown");
        assertEq(uint32(params >> 80), 52_200, "params.sessionOpen");
        assertEq(uint32(params >> 112), 72_000, "params.sessionClose");
        assertEq(_addr(where, s + 12), feed, "sequencerFeed");
        assertEq(_word(where, uint256(keccak256(abi.encode(uint256(20_800), s + 13)))), 1, "closedDays");
        assertEq(_addr(where, s + 14), address(registry), "registry");
        assertEq(_word(where, s + 15), 0, "the next field a later version adds goes here");
        _assertPlainSlotsEmpty(where);
    }

    function test_storage_ofTheFactory_itsOwnNamespace() public view {
        uint256 s = _namespace("basket.storage.VaultFactory");
        address where = address(factory);
        assertEq(_addr(where, s), address(beacon), "beacon");
        assertEq(_word(where, s + 1), 2, "vaults: the list's length");
        assertEq(_addr(where, uint256(keccak256(abi.encode(s + 1)))), address(vault), "vaults: the first");
        assertEq(_word(where, uint256(keccak256(abi.encode(address(vault), s + 2)))), 1, "isVault");
        uint256 mine = uint256(keccak256(abi.encode(owner, s + 3)));
        assertEq(_word(where, mine), 2, "byOwner: the list's length");
        assertEq(_addr(where, uint256(keccak256(abi.encode(mine))) + 1), address(follower), "byOwner: the second");
        uint256 bySalt = uint256(keccak256(abi.encode(PLAN_ID, keccak256(abi.encode(owner, s + 4)))));
        assertEq(_addr(where, bySalt), address(vault), "bySalt");
        assertEq(_word(where, s + 5), 0, "the next field a later version adds goes here");
    }

    function test_storage_ofTheRegistry() public {
        Weight[] memory next = _threeStocks();
        for (uint256 i; i < next.length; ++i) {
            if (next[i].bps == 5000) next[i].bps = 4500;
            else if (next[i].bps == 2000) next[i].bps = 2500;
        }
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.prank(stranger);
        registry.publish(id, next, bytes32(uint256(2)));

        uint256 s = _namespace("basket.storage.IndexRegistry");
        address where = address(registry);
        uint256 head = _word(where, s);
        assertEq(address(uint160(head)), address(factory), "factory");
        assertEq(uint32(head >> 160), PUBLISH_DELAY, "publishDelay, in the same slot");
        assertEq(_word(where, s + 1), 1, "ids: the list's length");
        assertEq(_word(where, uint256(keccak256(abi.encode(s + 1)))), uint256(id), "ids: the first");

        uint256 index = uint256(keccak256(abi.encode(id, s + 2)));
        uint256 first = _word(where, index);
        assertEq(address(uint160(first)), stranger, "index.creator");
        assertEq(uint64(first >> 160), block.timestamp, "index.lastPublishAt");
        assertEq(uint32(first >> 224), 2, "index.lastVersion");
        assertEq(_word(where, index + 1), uint256(FAMILY), "index.familyId");
        // The two slots a portfolio's versions live in, three words each.
        uint256 one = _word(where, index + 2);
        assertEq(uint32(one), 1, "slots[0].version");
        assertEq(uint64(one >> 32), 1_791_212_400, "slots[0].effectiveAt");
        assertEq(_word(where, index + 3), uint256(META), "slots[0].metaHash");
        assertEq(_word(where, index + 4), 3, "slots[0].components: the list's length");
        uint256 two = _word(where, index + 5);
        assertEq(uint32(two), 2, "slots[1].version");
        assertEq(uint64(two >> 32), block.timestamp + PUBLISH_DELAY, "slots[1].effectiveAt");
        assertEq(_word(where, index + 6), 2, "slots[1].metaHash");
        assertEq(_word(where, index + 7), 3, "slots[1].components: the list's length");
        uint256 component = _word(where, uint256(keccak256(abi.encode(index + 7))));
        assertEq(address(uint160(component)), next[0].token, "a component's token");
        assertEq(uint16(component >> 160), next[0].bps, "and its weight, in the same slot");

        assertEq(_word(where, s + 3), 0, "the next field a later version adds goes here");
        _assertPlainSlotsEmpty(where);
    }

    /// The beacon is not behind a proxy and is never upgraded, so its layout is the compiler's: the owner,
    /// the logic address, the proposed owner.
    function test_storage_ofTheBeacon() public {
        vm.prank(admin);
        beacon.transferOwnership(stranger);
        assertEq(_addr(address(beacon), 0), admin, "owner");
        assertEq(_addr(address(beacon), 1), address(logic), "implementation");
        assertEq(_addr(address(beacon), 2), stranger, "pendingOwner");
    }
}
