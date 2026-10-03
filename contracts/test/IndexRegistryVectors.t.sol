// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {stdJson} from "forge-std/StdJson.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IndexRegistry} from "../src/IndexRegistry.sol";
import {IIndexRegistry} from "../src/interfaces/IIndexRegistry.sol";
import {AssetConfig, IndexInfo, Limits, Weight} from "../src/interfaces/Types.sol";
import {VaultFixture} from "./helpers/VaultFixture.sol";
import {MockPlatform} from "./mocks/Platform.sol";
import {MockToken} from "./mocks/Tokens.sol";

// One case of the file, as Foundry decodes a JSON object: the fields of each struct are in the alphabetical
// order of the file's keys, which is the order the decoder gives them in.
struct Ctx {
    uint256 hasPending;
    uint256 lastPublishAt;
    uint256 time; // "now" in the file
    uint256 publishDelay;
}

struct Expect {
    string[] breaks;
    uint256 effectiveAt;
    string err; // "error" in the file
    uint256 ok;
    string reason;
    uint256 reasonId;
    uint256 turnoverBps;
}

struct Proposed {
    string[] assets;
    uint256 flags;
    uint256 maxFeeBps;
    uint256 n;
    uint256[] weightsBps;
}

struct Published {
    string[] assets;
    uint256 exists;
    uint256 n;
    uint256[] weightsBps;
}

struct Case {
    Ctx ctx;
    Expect expect;
    string group;
    string name;
    Proposed next;
    Published older;
    Published prev;
    string scenario;
    Published waiting;
}

/// A16: the four author limits, case by case from `fixtures/creator-limits/vectors.json`, the file the
/// TypeScript check and the Solana program are tested against too.
///
/// Each case is driven through the real registry: the state the case describes is built with real calls
/// (`scenario`), the clock is set, and the version is published. An accepted case must report the turnover
/// and the effective time the file gives; a refused one must revert with `CreatorLimit` carrying the file's
/// reason number. `previewPublish` must give the same answer before the call.
///
/// The names in the file are placeholders. Each is given an address here, and every list is sorted by
/// address after that, as the registry wants it.
abstract contract IndexRegistryVectorsTest is VaultFixture {
    using stdJson for string;

    bytes32 internal constant FAMILY = keccak256("vectors");
    bytes32 internal constant META = keccak256("meta");
    /// The delay a waiting version was published under in `pending_delay_lowered`, before it was lowered.
    uint32 internal constant LONG_DELAY = 172_800;

    address internal author = makeAddr("author");
    string internal json;
    mapping(bytes32 name => address) internal tokenOf;
    mapping(bytes32 name => uint16) internal ceilingOf;
    IndexRegistry internal reg;
    bytes32 internal id;

    uint256 internal accepted;
    uint256 internal refused;
    uint256 internal previewsSkipped;
    mapping(uint256 reason => uint256) internal seen;

    /// Puts `token` on the platform list with `ceilingBps`, or changes its ceiling.
    function _setCeiling(address token, uint16 ceilingBps) internal virtual;
    function _setCash(address token, uint16 ceilingBps) internal virtual;
    function _newRegistryUnderTest() internal virtual returns (IndexRegistry);
    function _platformAdmin() internal view virtual returns (address);

    function setUp() public {
        _deployPlatform();
        json = vm.readFile("../fixtures/creator-limits/vectors.json");
        reg = _newRegistryUnderTest();
        id = keccak256(abi.encode(author, FAMILY));

        uint256 n = json.readUint(".platform.n");
        string[] memory names = json.readStringArray(".platform.assets");
        uint256[] memory ceilings = json.readUintArray(".platform.ceilingsBps");
        bytes32 cashName = keccak256(bytes(json.readString(".platform.cash")));
        assertEq(names.length, n);
        for (uint256 i; i < n; ++i) {
            address token = address(new MockToken(18));
            bytes32 name = keccak256(bytes(names[i]));
            tokenOf[name] = token;
            ceilingOf[name] = uint16(ceilings[i]);
            if (name == cashName) _setCash(token, uint16(ceilings[i]));
            else _setCeiling(token, uint16(ceilings[i]));
        }
        string[] memory unlisted = json.readStringArray(".platform.unlisted");
        for (uint256 i; i < unlisted.length; ++i) {
            tokenOf[keccak256(bytes(unlisted[i]))] = address(new MockToken(18));
        }
    }

    /// The numbers in the file are the numbers in the contract.
    function test_A16_limits_matchTheSharedFile() public view {
        Limits memory l = reg.limits();
        assertEq(l.minAssets, json.readUint(".limits.minAssets"));
        assertEq(l.maxAssets, json.readUint(".limits.maxAssets"));
        assertEq(l.minWeightBps, json.readUint(".limits.minWeightBps"));
        assertEq(l.maxWeightBps, json.readUint(".limits.maxWeightBps"));
        assertEq(l.stepBps, json.readUint(".limits.stepBps"));
        assertEq(l.maxTurnoverBps, json.readUint(".limits.maxTurnoverBps"));
        assertEq(l.publishDelay, PUBLISH_DELAY);
        assertEq(json.readString(".error"), "CreatorLimit");
    }

    function test_A16_creatorLimits_everySharedVector() public {
        uint256 count = json.readUint(".count");
        assertEq(count, 87, "the file has a case this test has not been read against");
        Case[] memory cases = abi.decode(vm.parseJson(json, ".cases"), (Case[]));
        assertEq(cases.length, count);
        // The decoder and the structs above agree on the order of the fields.
        assertEq(cases[0].name, "three assets, the fewest allowed");
        assertEq(cases[0].scenario, "first");
        assertEq(cases[86].expect.reason, "TurnoverTooHigh");
        assertEq(cases[86].expect.breaks.length, 2);

        for (uint256 i; i < count; ++i) {
            uint256 snap = vm.snapshotState();
            bool previewed = _case(cases[i], string.concat("case ", vm.toString(i), ", ", cases[i].name));
            vm.revertToState(snap);
            // Counted after the state is put back, so the counts survive it.
            if (cases[i].expect.ok == 1) ++accepted;
            else ++refused;
            ++seen[cases[i].expect.reasonId];
            if (!previewed) ++previewsSkipped;
        }
        assertEq(accepted + refused, count);
        assertGt(accepted, 20);
        // All 14 reasons are exercised, each by at least one case.
        for (uint256 reason = 1; reason <= 14; ++reason) {
            assertGt(seen[reason], 0, string.concat("no case is refused for reason ", vm.toString(reason)));
        }
        // `previewPublish` takes no fee and no flags, so the five cases that set them cannot be previewed.
        assertEq(previewsSkipped, 5);
    }

    function _case(Case memory c, string memory label) internal returns (bool previewed) {
        Weight[] memory next = _list(c.next.assets, c.next.weightsBps, c.next.n);
        assertEq(c.expect.ok == 1, c.expect.reasonId == 0, label);
        assertEq(c.expect.err, c.expect.ok == 1 ? "" : "CreatorLimit", label);
        if (keccak256(bytes(c.scenario)) == keccak256("first")) return _first(c, next, label);
        _later(c, next, label);
        return true;
    }

    /// A first version: `create`, which takes effect at once.
    function _first(Case memory c, Weight[] memory next, string memory label) internal returns (bool previewed) {
        bool ok = c.expect.ok == 1;
        uint64 effectiveAt = uint64(c.expect.effectiveAt);
        _setDelay(uint32(c.ctx.publishDelay));
        vm.warp(c.ctx.time);
        previewed = c.next.maxFeeBps == 0 && c.next.flags == 0;
        if (previewed) _assertPreview(next, c, label);

        vm.prank(author);
        if (!ok) {
            vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.CreatorLimit.selector, uint8(c.expect.reasonId)));
            reg.create(FAMILY, next, META, uint16(c.next.maxFeeBps), uint8(c.next.flags));
            return previewed;
        }
        vm.expectEmit(address(reg));
        emit IIndexRegistry.RecipePublished(id, 1, author, next, effectiveAt, 0, META);
        assertEq(reg.create(FAMILY, next, META, uint16(c.next.maxFeeBps), uint8(c.next.flags)), id, label);
        IndexInfo memory info = reg.indexInfo(id);
        assertEq(info.active.version, 1, label);
        assertEq(info.active.effectiveAt, effectiveAt, label);
        assertEq(info.pending.version, 0, label);
        assertEq(effectiveAt, c.ctx.time, label);
        assertEq(c.expect.turnoverBps, 0, label);
    }

    /// A later version: the state is built, then `publish`.
    function _later(Case memory c, Weight[] memory next, string memory label) internal {
        _build(c, keccak256(bytes(c.scenario)), label);
        vm.warp(c.ctx.time);
        // The state is the one the case describes before anything is asked of it.
        (, Weight[] memory inEffect) = reg.active(id);
        Weight[] memory prev = _list(c.prev.assets, c.prev.weightsBps, c.prev.n);
        assertEq(keccak256(abi.encode(inEffect)), keccak256(abi.encode(prev)), label);
        (uint32 waiting,,) = reg.pending(id);
        assertEq(waiting != 0, c.ctx.hasPending == 1, label);

        _assertPreview(next, c, label);
        vm.prank(author);
        if (c.expect.ok != 1) {
            vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.CreatorLimit.selector, uint8(c.expect.reasonId)));
            reg.publish(id, next, META);
            return;
        }
        // Version 1 is `prev`, or the one before it. A version that waited, or was cancelled, took number 2:
        // a number is never used twice.
        bytes32 scenario = keccak256(bytes(c.scenario));
        uint32 number = scenario == keccak256("matured") || scenario == keccak256("cancelled") ? 3 : 2;
        uint64 effectiveAt = uint64(c.expect.effectiveAt);
        vm.expectEmit(address(reg));
        emit IIndexRegistry.RecipePublished(id, number, author, next, effectiveAt, uint16(c.expect.turnoverBps), META);
        (uint32 version, uint64 effective) = reg.publish(id, next, META);
        assertEq(version, number, label);
        assertEq(effective, effectiveAt, label);
        assertEq(effectiveAt, c.ctx.time + c.ctx.publishDelay, label);
    }

    /// Builds the state a case starts from, with real calls at the times the case gives.
    function _build(Case memory c, bytes32 scenario, string memory label) internal {
        uint256 last = c.ctx.lastPublishAt;
        uint32 delay = uint32(c.ctx.publishDelay);
        Weight[] memory prev = _list(c.prev.assets, c.prev.weightsBps, c.prev.n);
        if (scenario == keccak256("next") || scenario == keccak256("next_ceiling_lowered")) {
            // `prev` is version 1, published at `last`. Where it holds a weight over today's ceiling, it was
            // published while that ceiling was still 5,000.
            bool lowered = scenario == keccak256("next_ceiling_lowered");
            _setDelay(delay);
            vm.warp(last);
            if (lowered) _ceilings(c.prev.assets, true);
            _create(prev, label);
            if (lowered) _ceilings(c.prev.assets, false);
        } else if (scenario == keccak256("matured")) {
            // `older` was version 1, one delay before `last`; `prev` was published at `last` and has waited.
            _setDelay(delay);
            vm.warp(last - delay);
            _create(_list(c.older.assets, c.older.weightsBps, c.older.n), label);
            vm.warp(last);
            _publish(prev);
        } else {
            // `prev` is version 1; `waiting` was published at `last`, under the delay of the time.
            bool lowered = scenario == keccak256("pending_delay_lowered");
            uint32 then = lowered ? LONG_DELAY : delay;
            _setDelay(then);
            vm.warp(last - then);
            _create(prev, label);
            vm.warp(last);
            _publish(_list(c.waiting.assets, c.waiting.weightsBps, c.waiting.n));
            if (lowered) {
                _setDelay(delay);
            } else if (scenario == keccak256("cancelled")) {
                vm.prank(author);
                reg.cancel(id);
            } else {
                assertEq(scenario, keccak256("pending"), string.concat(label, ": a scenario this test does not know"));
            }
        }
    }

    function _assertPreview(Weight[] memory next, Case memory c, string memory label) internal view {
        (bytes4 err, uint8 why, uint16 moved, uint64 effective,) = reg.previewPublish(id, next);
        assertEq(err, c.expect.ok == 1 ? bytes4(0) : IIndexRegistry.CreatorLimit.selector, label);
        assertEq(why, c.expect.reasonId, label);
        assertEq(moved, c.expect.turnoverBps, label);
        assertEq(effective, c.expect.effectiveAt, label);
    }

    function _create(Weight[] memory list, string memory label) internal {
        vm.prank(author);
        assertEq(reg.create(FAMILY, list, META, 0, 0), id, label);
    }

    function _publish(Weight[] memory list) internal {
        vm.prank(author);
        reg.publish(id, list, META);
    }

    function _setDelay(uint32 delay) internal {
        vm.prank(_platformAdmin());
        reg.setPublishDelay(delay);
    }

    /// Sets every asset of a list to a ceiling of 5,000, or back to the platform's.
    function _ceilings(string[] memory names, bool raised) internal {
        for (uint256 k; k < names.length; ++k) {
            bytes32 name = keccak256(bytes(names[k]));
            _setCeiling(tokenOf[name], raised ? 5000 : ceilingOf[name]);
        }
    }

    /// A list of the file, names mapped to addresses, sorted by address.
    function _list(string[] memory names, uint256[] memory weights, uint256 n)
        internal
        view
        returns (Weight[] memory list)
    {
        assertEq(names.length, n);
        assertEq(weights.length, n);
        list = new Weight[](n);
        for (uint256 k; k < n; ++k) {
            address token = tokenOf[keccak256(bytes(names[k]))];
            assertTrue(token != address(0), string.concat("no address for ", names[k]));
            list[k] = Weight(token, uint16(weights[k]));
        }
        for (uint256 a = 1; a < n; ++a) {
            Weight memory w = list[a];
            uint256 b = a;
            for (; b > 0 && list[b - 1].token > w.token; --b) {
                list[b] = list[b - 1];
            }
            list[b] = w;
        }
    }
}

/// Against the real factory. Its config holds a ceiling to 5,000, so the platform's 10,000 is stored as
/// 5,000; the cases come out the same, since the registry's own cap is 5,000 too.
contract IndexRegistryVectorsOnTheFactoryTest is IndexRegistryVectorsTest {
    function _newRegistryUnderTest() internal view override returns (IndexRegistry) {
        return registry;
    }

    function _platformAdmin() internal view override returns (address) {
        return admin;
    }

    function _setCeiling(address token, uint16 ceilingBps) internal override {
        AssetConfig memory cfg = _assetConfig(18);
        cfg.maxWeightBps = ceilingBps > 5000 ? 5000 : ceilingBps;
        vm.prank(admin);
        factory.setAsset(token, cfg);
    }

    function _setCash(address token, uint16 ceilingBps) internal override {
        _setCeiling(token, ceilingBps);
        vm.prank(admin);
        factory.setCashToken(token);
    }
}

/// Against a platform list that holds the file's ceilings as they are, 10,000 included: the cap of 5,000 is
/// then the registry's alone.
contract IndexRegistryVectorsOnAnOpenListTest is IndexRegistryVectorsTest {
    MockPlatform internal platform;

    function _newRegistryUnderTest() internal override returns (IndexRegistry) {
        platform = new MockPlatform(admin, guardian);
        bytes memory init = abi.encodeCall(IndexRegistry.initialize, (address(platform), PUBLISH_DELAY));
        return IndexRegistry(address(new ERC1967Proxy(address(new IndexRegistry()), init)));
    }

    function _platformAdmin() internal view override returns (address) {
        return admin;
    }

    function _setCeiling(address token, uint16 ceilingBps) internal override {
        platform.list(token, ceilingBps);
    }

    function _setCash(address token, uint16 ceilingBps) internal override {
        platform.list(token, ceilingBps);
        platform.setCashToken(token);
    }
}
