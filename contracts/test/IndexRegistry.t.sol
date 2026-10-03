// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {stdJson} from "forge-std/StdJson.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IndexRegistry} from "../src/IndexRegistry.sol";
import {IIndexRegistry} from "../src/interfaces/IIndexRegistry.sol";
import {IndexInfo, Limits, Weight} from "../src/interfaces/Types.sol";
import {SwapFixture} from "./helpers/SwapFixture.sol";

/// A stand-in for the next version of the registry logic: the same contract with one more function.
contract IndexRegistryV2Dummy is IndexRegistry {
    function version() external pure returns (uint256) {
        return 2;
    }
}

/// The registry around the limits: who may publish and cancel, how a version waits and takes effect with no
/// transaction, how portfolios are found, and who may change the delay or the code. The limits themselves
/// are in `IndexRegistryVectors.t.sol`.
contract IndexRegistryTest is SwapFixture {
    using stdJson for string;

    bytes32 internal constant FAMILY = keccak256("family");
    bytes32 internal constant META_1 = keccak256("meta-1");
    bytes32 internal constant META_2 = keccak256("meta-2");

    address internal author = makeAddr("author");
    bytes32 internal id;
    uint256 internal createdAt;

    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function setUp() public {
        _deploySwapPlatform();
        vm.warp(1_791_212_400);
        createdAt = block.timestamp;
        vm.prank(author);
        id = registry.create(FAMILY, _threeStocks(), META_1, 0, 0);
    }

    /// The three stocks with 5 points moved from the heaviest to the lightest: a 5% turnover.
    function _moved() internal view returns (Weight[] memory next) {
        next = _threeStocks();
        for (uint256 i; i < next.length; ++i) {
            if (next[i].bps == 5000) next[i].bps = 4500;
            else if (next[i].bps == 2000) next[i].bps = 2500;
        }
    }

    function _same(Weight[] memory a, Weight[] memory b) internal pure {
        assertEq(keccak256(abi.encode(a)), keccak256(abi.encode(b)));
    }

    function _publishNext() internal returns (uint32 version, uint64 effectiveAt) {
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.prank(author);
        return registry.publish(id, _moved(), META_2);
    }

    // ---- the registry behind its proxy

    function test_initialize_setsTheFactoryAndTheDelay() public view {
        assertEq(registry.factory(), address(factory));
        assertEq(registry.publishDelay(), PUBLISH_DELAY);
    }

    function test_A15_initialize_revertsOnTheRegistrysLogicAndOnItsLiveProxy() public {
        IndexRegistry bareLogic = new IndexRegistry();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bareLogic.initialize(address(factory), PUBLISH_DELAY);
        vm.prank(admin);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        registry.initialize(stranger, PUBLISH_DELAY);
        assertEq(registry.factory(), address(factory));
    }

    function test_initialize_revertsWithoutAFactoryOrWithADelayOutOfBounds() public {
        IndexRegistry impl = new IndexRegistry();
        bytes memory init = abi.encodeCall(IndexRegistry.initialize, (address(0), PUBLISH_DELAY));
        vm.expectRevert(IIndexRegistry.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), init);

        init = abi.encodeCall(IndexRegistry.initialize, (address(factory), 59));
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.ParamOutOfBounds.selector, bytes32("publishDelay"), 59));
        new ERC1967Proxy(address(impl), init);
    }

    // ---- create

    function test_create_publishesVersion1AtOnce() public view {
        assertEq(id, keccak256(abi.encode(author, FAMILY)));
        assertEq(registry.creatorOf(id), author);
        (uint32 version, Weight[] memory components) = registry.active(id);
        assertEq(version, 1);
        _same(components, _threeStocks());
        (uint32 waiting, uint64 effectiveAt, Weight[] memory none) = registry.pending(id);
        assertEq(waiting, 0);
        assertEq(effectiveAt, 0);
        assertEq(none.length, 0);

        IndexInfo memory info = registry.indexInfo(id);
        assertEq(info.creator, author);
        assertEq(info.familyId, FAMILY);
        assertEq(info.active.version, 1);
        assertEq(info.active.effectiveAt, createdAt);
        assertEq(info.active.metaHash, META_1);
        _same(info.active.components, _threeStocks());
        assertEq(info.pending.version, 0);
        assertEq(info.pending.components.length, 0);
    }

    /// The id is the creator and the family, with no chain in it: one portfolio, one id on every chain.
    /// Two creators can use the same family id and get two portfolios; one creator cannot use it twice.
    function test_create_idIsTheCreatorAndTheFamily() public {
        vm.prank(stranger);
        bytes32 other = registry.create(FAMILY, _threeStocks(), META_1, 0, 0);
        assertEq(other, keccak256(abi.encode(stranger, FAMILY)));
        assertTrue(other != id);

        vm.prank(author);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.IndexExists.selector, id));
        registry.create(FAMILY, _moved(), META_2, 0, 0);
        (, Weight[] memory components) = registry.active(id);
        _same(components, _threeStocks());
    }

    /// Shared portfolios are found by reading, with no event.
    function test_create_isListed() public {
        assertEq(registry.indexCount(), 1);
        assertEq(registry.indexAt(0), id);
        vm.prank(stranger);
        bytes32 other = registry.create(keccak256("another"), _threeStocks(), META_1, 0, 0);
        assertEq(registry.indexCount(), 2);
        assertEq(registry.indexAt(1), other);
        vm.expectRevert();
        registry.indexAt(2);
    }

    function test_unknownId_readsAsNothing() public view {
        bytes32 missing = keccak256("missing");
        (uint32 version, Weight[] memory components) = registry.active(missing);
        assertEq(version, 0);
        assertEq(components.length, 0);
        (uint32 waiting,,) = registry.pending(missing);
        assertEq(waiting, 0);
        assertEq(registry.creatorOf(missing), address(0));
        assertEq(registry.indexInfo(missing).active.version, 0);
    }

    /// A list out of order is not judged against the limits at all: it is refused as it stands.
    function test_unsortedList_isRefusedEverywhere() public {
        Weight[] memory unsorted = _threeStocks();
        (unsorted[0], unsorted[2]) = (unsorted[2], unsorted[0]);

        vm.prank(stranger);
        vm.expectRevert(IIndexRegistry.NotSorted.selector);
        registry.create(FAMILY, unsorted, META_1, 0, 0);

        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.prank(author);
        vm.expectRevert(IIndexRegistry.NotSorted.selector);
        registry.publish(id, unsorted, META_2);

        (bytes4 err, uint8 reason,,,) = registry.previewPublish(id, unsorted);
        assertEq(err, IIndexRegistry.NotSorted.selector);
        assertEq(reason, 0);
    }

    // ---- publish: a version waits, then is in effect with no transaction

    function test_publish_waitsOneDelayThenTakesEffectByTheClock() public {
        vm.warp(createdAt + PUBLISH_DELAY);
        vm.expectEmit(address(registry));
        emit IIndexRegistry.RecipePublished(
            id, 2, author, _moved(), uint64(block.timestamp + PUBLISH_DELAY), 500, META_2
        );
        vm.prank(author);
        (uint32 version, uint64 effectiveAt) = registry.publish(id, _moved(), META_2);
        assertEq(version, 2);
        assertEq(effectiveAt, block.timestamp + PUBLISH_DELAY);

        // Until then version 1 is in effect and version 2 waits.
        vm.warp(effectiveAt - 1);
        (uint32 active,) = registry.active(id);
        assertEq(active, 1);
        (uint32 waiting, uint64 waitsUntil, Weight[] memory components) = registry.pending(id);
        assertEq(waiting, 2);
        assertEq(waitsUntil, effectiveAt);
        _same(components, _moved());
        IndexInfo memory info = registry.indexInfo(id);
        assertEq(info.active.version, 1);
        assertEq(info.pending.version, 2);
        assertEq(info.pending.metaHash, META_2);

        // At its time it is the one in effect, and nothing was sent.
        vm.warp(effectiveAt);
        (active, components) = registry.active(id);
        assertEq(active, 2);
        _same(components, _moved());
        (waiting,,) = registry.pending(id);
        assertEq(waiting, 0);
        info = registry.indexInfo(id);
        assertEq(info.active.version, 2);
        assertEq(info.active.effectiveAt, effectiveAt);
        assertEq(info.active.metaHash, META_2);
        assertEq(info.pending.version, 0);
    }

    /// Three versions through two slots: each takes the place of the one before the one in effect.
    function test_publish_keepsTheVersionInEffectAndTheOneWaiting() public {
        (, uint64 second) = _publishNext();
        vm.warp(second);
        vm.prank(author);
        (uint32 version, uint64 third) = registry.publish(id, _threeStocks(), META_1);
        assertEq(version, 3);

        (uint32 active, Weight[] memory components) = registry.active(id);
        assertEq(active, 2);
        _same(components, _moved());
        (uint32 waiting,, Weight[] memory next) = registry.pending(id);
        assertEq(waiting, 3);
        _same(next, _threeStocks());

        vm.warp(third);
        (active, components) = registry.active(id);
        assertEq(active, 3);
        _same(components, _threeStocks());

        vm.prank(author);
        (version,) = registry.publish(id, _moved(), META_2);
        assertEq(version, 4);
        (active,) = registry.active(id);
        assertEq(active, 3);
    }

    function test_publish_revertsForAnyoneButTheCreator() public {
        vm.warp(createdAt + PUBLISH_DELAY);
        address[3] memory callers = [stranger, admin, guardian];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.NotCreator.selector, callers[i]));
            registry.publish(id, _moved(), META_2);
        }
        (uint32 waiting,,) = registry.pending(id);
        assertEq(waiting, 0);
    }

    function test_publish_revertsOnAnIdThatDoesNotExist() public {
        bytes32 missing = keccak256("missing");
        vm.prank(author);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.IndexNotFound.selector, missing));
        registry.publish(missing, _moved(), META_2);
    }

    // ---- cancel

    function test_cancel_byTheCreatorTheGuardianOrTheAdmin() public {
        address[3] memory callers = [author, guardian, admin];
        uint32 expected = 2;
        for (uint256 i; i < callers.length; ++i) {
            (uint32 version,) = _publishNext();
            assertEq(version, expected, "a cancelled version's number is not used again");
            vm.expectEmit(address(registry));
            emit IIndexRegistry.VersionCancelled(id, version, callers[i]);
            vm.prank(callers[i]);
            registry.cancel(id);

            (uint32 waiting,,) = registry.pending(id);
            assertEq(waiting, 0);
            (uint32 active, Weight[] memory components) = registry.active(id);
            assertEq(active, 1);
            _same(components, _threeStocks());
            ++expected;
        }
    }

    function test_cancel_revertsForAStranger() public {
        _publishNext();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.NotCreator.selector, stranger));
        registry.cancel(id);
        (uint32 waiting,,) = registry.pending(id);
        assertEq(waiting, 2);
    }

    /// Only a version that is still waiting can be cancelled. One whose time has come is in effect: vaults
    /// may already hold it.
    function test_cancel_revertsWhenNothingIsWaiting() public {
        vm.prank(author);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.NothingPending.selector, id));
        registry.cancel(id);

        (, uint64 effectiveAt) = _publishNext();
        vm.warp(effectiveAt);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.NothingPending.selector, id));
        registry.cancel(id);
        (uint32 active,) = registry.active(id);
        assertEq(active, 2);

        bytes32 missing = keccak256("missing");
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.IndexNotFound.selector, missing));
        registry.cancel(missing);
    }

    // ---- previewPublish

    function test_previewPublish_saysWhenTheNextVersionMayCome() public {
        // An id that does not exist yet: judged as a first version, in effect at once.
        bytes32 fresh = keccak256(abi.encode(stranger, FAMILY));
        (bytes4 err, uint8 reason, uint16 turnover, uint64 effectiveAt, uint64 nextAllowedAt) =
            registry.previewPublish(fresh, _threeStocks());
        assertEq(err, bytes4(0));
        assertEq(reason, 0);
        assertEq(turnover, 0);
        assertEq(effectiveAt, block.timestamp);
        assertEq(nextAllowedAt, 0);

        // Too soon after version 1.
        (err, reason,,, nextAllowedAt) = registry.previewPublish(id, _moved());
        assertEq(err, IIndexRegistry.CreatorLimit.selector);
        assertEq(reason, 12);
        assertEq(nextAllowedAt, createdAt + PUBLISH_DELAY);

        // On time.
        vm.warp(createdAt + PUBLISH_DELAY);
        (err, reason, turnover, effectiveAt,) = registry.previewPublish(id, _moved());
        assertEq(err, bytes4(0));
        assertEq(turnover, 500);
        assertEq(effectiveAt, block.timestamp + PUBLISH_DELAY);

        // A version published under a longer delay than today's still waits its own time: the next one may
        // come when it takes effect, not one of today's delays after it was published.
        vm.prank(admin);
        registry.setPublishDelay(3600);
        vm.warp(createdAt + 3600);
        vm.prank(author);
        (, uint64 waitsUntil) = registry.publish(id, _moved(), META_2);
        vm.prank(admin);
        registry.setPublishDelay(PUBLISH_DELAY);
        vm.warp(block.timestamp + PUBLISH_DELAY + 100);
        (err, reason,,, nextAllowedAt) = registry.previewPublish(id, _threeStocks());
        assertEq(err, IIndexRegistry.CreatorLimit.selector);
        assertEq(reason, 11);
        assertEq(nextAllowedAt, waitsUntil);
        assertEq(waitsUntil, createdAt + 7200);
    }

    // ---- the delay, and the launch latch

    function test_setPublishDelay_isTheFactoryAdminsAndStaysInBounds() public {
        address[3] memory callers = [stranger, author, guardian];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.NotAdmin.selector, callers[i]));
            registry.setPublishDelay(600);
        }

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.ParamOutOfBounds.selector, bytes32("publishDelay"), 59));
        registry.setPublishDelay(59);
        vm.expectRevert(
            abi.encodeWithSelector(IIndexRegistry.ParamOutOfBounds.selector, bytes32("publishDelay"), 30 days + 1)
        );
        registry.setPublishDelay(30 days + 1);

        vm.expectEmit(address(registry));
        emit IIndexRegistry.PublishDelaySet(60);
        registry.setPublishDelay(60);
        assertEq(registry.publishDelay(), 60);
        registry.setPublishDelay(30 days);
        assertEq(registry.limits().publishDelay, 30 days);
        vm.stopPrank();
    }

    /// `launch()` on the factory is one-way and needs no second transaction here: from then on the delay in
    /// force is at least 48 hours, whatever was stored, and cannot be set lower.
    function test_launch_raisesTheDelayToItsFloorOf48Hours() public {
        assertEq(registry.publishDelay(), PUBLISH_DELAY);
        vm.prank(admin);
        factory.launch();
        assertEq(registry.publishDelay(), 172_800);
        assertEq(registry.limits().publishDelay, 172_800);

        vm.startPrank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(IIndexRegistry.ParamOutOfBounds.selector, bytes32("publishDelay"), 172_799)
        );
        registry.setPublishDelay(172_799);
        registry.setPublishDelay(172_800);
        registry.setPublishDelay(200_000);
        assertEq(registry.publishDelay(), 200_000);
        vm.stopPrank();
    }

    function test_launch_aVersionPublishedAfterItWaits48Hours() public {
        vm.prank(admin);
        factory.launch();

        // 300 seconds after version 1 is no longer enough.
        vm.warp(createdAt + PUBLISH_DELAY);
        vm.prank(author);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.CreatorLimit.selector, uint8(12)));
        registry.publish(id, _moved(), META_2);

        vm.warp(createdAt + 172_800);
        vm.prank(author);
        (, uint64 effectiveAt) = registry.publish(id, _moved(), META_2);
        assertEq(effectiveAt, block.timestamp + 172_800);
    }

    function test_limits_areTheFourRules() public view {
        Limits memory l = registry.limits();
        assertEq(l.minAssets, 3);
        assertEq(l.maxAssets, 12);
        assertEq(l.minWeightBps, 200);
        assertEq(l.maxWeightBps, 5000);
        assertEq(l.stepBps, 50);
        assertEq(l.maxTurnoverBps, 2000);
        assertEq(l.publishDelay, PUBLISH_DELAY);
    }

    // ---- the meta hash

    /// The registry stores the hash of a portfolio's name and copy and never builds the text. The six worked
    /// cases of `fixtures/creator-limits/meta-hash.json`: SHA-256 of the bytes is the hash, here as it is in
    /// TypeScript, and what is stored is what was given.
    function test_metaHash_sixSharedCases() public {
        string memory json = vm.readFile("../fixtures/creator-limits/meta-hash.json");
        uint256 count = json.readUint(".count");
        assertEq(count, 6);
        for (uint256 i; i < count; ++i) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            bytes memory text = vm.parseBytes(string.concat("0x", json.readString(string.concat(c, ".utf8Hex"))));
            bytes32 expected = vm.parseBytes32(string.concat("0x", json.readString(string.concat(c, ".sha256"))));
            assertEq(sha256(text), expected, json.readString(string.concat(c, ".case")));
            // The text the file spells out is those same bytes.
            assertEq(keccak256(bytes(json.readString(string.concat(c, ".canonical")))), keccak256(text));

            vm.prank(stranger);
            bytes32 made = registry.create(bytes32(i), _threeStocks(), expected, 0, 0);
            assertEq(registry.indexInfo(made).active.metaHash, expected);
        }
    }

    // ---- replacing the registry's logic (A15)

    function test_A15_upgrade_keepsStateAndIsTheFactoryAdmins() public {
        _publishNext();
        IndexRegistryV2Dummy v2 = new IndexRegistryV2Dummy();
        address[3] memory callers = [stranger, author, guardian];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.NotAdmin.selector, callers[i]));
            registry.upgradeToAndCall(address(v2), "");
        }

        vm.prank(admin);
        registry.upgradeToAndCall(address(v2), "");

        assertEq(IndexRegistryV2Dummy(address(registry)).version(), 2);
        assertEq(address(uint160(uint256(vm.load(address(registry), ERC1967Utils.IMPLEMENTATION_SLOT)))), address(v2));
        assertEq(registry.factory(), address(factory));
        assertEq(registry.indexCount(), 1);
        (uint32 active,) = registry.active(id);
        assertEq(active, 1);
        (uint32 waiting,,) = registry.pending(id);
        assertEq(waiting, 2);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        v2.initialize(stranger, PUBLISH_DELAY);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        registry.initialize(stranger, PUBLISH_DELAY);
    }

    function test_upgrade_revertsOnTheRegistrysLogicItself() public {
        IndexRegistry bareLogic = new IndexRegistry();
        IndexRegistryV2Dummy v2 = new IndexRegistryV2Dummy();
        vm.prank(admin);
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        bareLogic.upgradeToAndCall(address(v2), "");
    }
}
