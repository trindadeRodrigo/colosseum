// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {BasketVault} from "../src/BasketVault.sol";
import {AssetConfig, Weight} from "../src/interfaces/Types.sol";
import {KeeperFixture} from "./helpers/KeeperFixture.sol";
import {SwapFixture} from "./helpers/SwapFixture.sol";

/// The vault logic with one more view, so that the place of a field nothing reads yet can be shown.
contract VaultOperatorReader is BasketVault {
    function operatorForTest() external view returns (address) {
        return _vault().operator;
    }
}

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
        // EVM-3, appended: their places are pinned with a keeper trade in KeeperStorageLayoutTest.
        assertEq(_word(where, s + 8), 0, "lastKeeperAt: a mapping's own slot stays empty");
        assertEq(_word(where, s + 9), 0, "lossAccum");
        assertEq(_word(where, s + 10), 0, "lossTs");
        // The mainnet setup, appended
        assertEq(_word(where, s + 11), 10 * USD, "netDeposited");
        assertEq(_addr(where, s + 12), address(cash), "depositToken");
        assertEq(_word(where, s + 13), 0, "the next field a later version adds goes here");
        _assertPlainSlotsEmpty(where);
    }

    /// `autoFollow` and `operator` share a slot with `acceptedVersion`. Nothing sets them yet, so their
    /// places are shown by writing the slot and reading it back: the version in bits 0 to 31, auto-follow
    /// in bits 32 to 39, the operator in bits 40 to 199. The operator has no getter until the keeper path,
    /// so the beacon is moved to the same logic with one more view.
    function test_storage_ofAVault_theSlotAutoFollowAndTheOperatorShareWithTheVersion() public {
        uint256 s = _namespace("basket.storage.BasketVault");
        address operator = makeAddr("operator");
        vm.store(
            address(follower), bytes32(s + 6), bytes32((uint256(uint160(operator)) << 40) | (uint256(1) << 32) | 7)
        );
        (, uint32 version, bool autoFollow) = follower.following();
        assertEq(version, 7);
        assertTrue(autoFollow);

        VaultOperatorReader reader = new VaultOperatorReader();
        vm.prank(admin);
        beacon.upgradeTo(address(reader));
        assertEq(VaultOperatorReader(payable(address(follower))).operatorForTest(), operator);
        assertEq(VaultOperatorReader(payable(address(vault))).operatorForTest(), address(0));
    }

    /// Three structs are stored where they cannot grow: `Params` inline in the config with fields after it,
    /// `Weight` as an array element, and the registry's stored version twice in a fixed array. Each fills
    /// one slot or a fixed run of them, pinned here by what sits right after.
    function test_storage_theStructsThatCannotGrow() public view {
        uint256 c = _namespace("basket.storage.VaultConfig");
        assertEq(_word(address(factory), c + 11) >> 144, 0, "Params ends at bit 143 of its slot");
        assertEq(_addr(address(factory), c + 10), keeper, "the field before Params");
        assertEq(_addr(address(factory), c + 14), address(registry), "and the fields after it");

        uint256 v = _namespace("basket.storage.BasketVault");
        uint256 first = uint256(keccak256(abi.encode(v + 7)));
        Weight[] memory targets = _threeStocks();
        for (uint256 i; i < targets.length; ++i) {
            uint256 element = _word(address(follower), first + i);
            assertEq(address(uint160(element)), targets[i].token, "a Weight is one slot");
            assertEq(element >> 176, 0, "token and weight, nothing more");
        }
    }

    function test_storage_ofTheFactory_theConfigNamespace() public {
        AssetConfig memory priced = _assetConfig(18);
        priced.flags = 1;
        priced.averageFeed = stranger;
        priced.minPrice = 100e8;
        priced.maxPrice = 150e8;
        vm.startPrank(admin);
        factory.setAsset(address(stockA), priced);
        factory.setPriceDevBps(321);
        factory.setSessionPriceAge(4321);
        factory.setDepositCaps(7000 * USD, 9000 * USD);
        factory.launch();
        factory.proposeAdmin(stranger);
        factory.removeAsset(address(stockC));
        factory.setSequencerFeed(feed);
        vm.stopPrank();
        vm.startPrank(guardian);
        factory.pauseKeeper();
        factory.extendClosedUntil(1_800_000_000);
        factory.addClosedDay(20_800);
        factory.pauseDeposits();
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
        // EVM-3, appended
        assertEq(uint16(_word(where, s + 14) >> 160), 321, "priceDevBps, in the registry's slot");
        // The mainnet setup, appended: two small fields in what was left of the registry's slot, then four
        // slots of their own. A factory upgraded from the layout before reads zero in all of them: deposits
        // not paused, no in-session age, and both caps zero, so no deposit until the admin sets them.
        assertEq(uint8(_word(where, s + 14) >> 176), 1, "depositsPaused, after priceDevBps");
        assertEq(uint32(_word(where, s + 14) >> 184), 4321, "sessionPriceAge, after it");
        assertEq(_word(where, s + 14) >> 216, 0, "sessionPriceAge ends at bit 215");
        assertEq(_word(where, s + 15), 7000 * USD, "vaultCap");
        assertEq(_word(where, s + 16), 9000 * USD, "totalCap");
        assertEq(_word(where, s + 17), 10 * USD, "totalDeposited");
        assertEq(_word(where, s + 18), 0, "deposited: a mapping's own slot stays empty");
        assertEq(
            _word(where, uint256(keccak256(abi.encode(address(follower), s + 18)))), 10 * USD, "deposited: a vault"
        );
        uint256 asset = uint256(keccak256(abi.encode(address(stockA), s + 4)));
        uint256 third = _word(where, asset + 2);
        assertEq(uint64(third), 0, "assets: haltUntil, alone at the start of the third slot");
        assertEq(uint8(third >> 64), 1, "assets: flags, after haltUntil");
        assertEq(address(uint160(third >> 72)), stranger, "assets: averageFeed, after flags");
        uint256 fourth = _word(where, asset + 3);
        assertEq(uint128(fourth), 100e8, "assets: minPrice, in the fourth slot");
        assertEq(fourth >> 128, 150e8, "assets: maxPrice, beside it");
        assertEq(_word(where, asset + 4), 0, "assets: an entry is four slots");
        assertEq(_word(where, s + 19), 0, "the next field a later version adds goes here");
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

/// Where the keeper's fields of a vault are (EVM-3), written by a keeper trade that loses something.
contract KeeperStorageLayoutTest is KeeperFixture {
    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function setUp() public {
        _deployKeeperPlatform();
    }

    function test_storage_theKeepersFields() public {
        _keeperSwap(_buy(direct, address(stockA), 4000 * USD, 120));
        uint256 s =
            uint256(keccak256(abi.encode(uint256(keccak256("basket.storage.BasketVault")) - 1))) & ~uint256(0xff);
        address where = address(vault);
        assertEq(uint256(vm.load(where, bytes32(s + 8))), 0, "lastKeeperAt: the mapping's own slot");
        bytes32 entry = keccak256(abi.encode(address(stockA), s + 8));
        assertEq(uint256(vm.load(where, entry)), block.timestamp, "lastKeeperAt: an asset's entry");
        assertEq(uint256(vm.load(where, bytes32(s + 9))), 48 * USD, "lossAccum");
        assertEq(uint256(vm.load(where, bytes32(s + 10))), block.timestamp, "lossTs");
        assertEq(uint256(vm.load(where, bytes32(s + 11))), vault.netDeposited(), "netDeposited, after the keeper's");
        assertGt(vault.netDeposited(), 0);
        assertEq(uint256(vm.load(where, bytes32(s + 13))), 0, "the next field a later version adds goes here");
    }
}
