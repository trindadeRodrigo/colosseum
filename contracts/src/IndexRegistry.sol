// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IIndexRegistry} from "./interfaces/IIndexRegistry.sol";
import {IVaultConfig} from "./interfaces/IVaultConfig.sol";
import {IndexInfo, IndexVersion, Limits, Weight} from "./interfaces/Types.sol";

/// The shared portfolios of one chain, and the four limits on what their authors may publish
/// (DESIGN-VAULT.md section 6). The logic contract behind a UUPS proxy.
///
/// It keeps two versions of each portfolio, the one in effect and the one waiting, and nothing older:
/// history is in the `RecipePublished` events. A waiting version takes effect when its time comes with no
/// transaction; every read here answers for the time it is asked at.
///
/// The limits are constants. They are checked against the platform's asset list, read from the factory at
/// the moment of publishing. The rules, their numbers and their order are those of
/// `fixtures/creator-limits/README.md`, and a refusal names the lowest-numbered rule broken.
///
/// It has no admin of its own. The factory's admin sets the publish delay and replaces this logic; the
/// factory's guardian can cancel a waiting version; the factory's `launched()` raises the delay's floor.
contract IndexRegistry is Initializable, UUPSUpgradeable, IIndexRegistry {
    /// One version as stored. `version == 0` means the slot is empty.
    struct StoredVersion {
        uint32 version;
        uint64 effectiveAt;
        bytes32 metaHash;
        Weight[] components;
    }

    struct Index {
        address creator;
        // When the last version was published, cancelled or not: the next may come one delay later.
        uint64 lastPublishAt;
        // The number of the last version published. Never reused, so a number names one list for good.
        uint32 lastVersion;
        bytes32 familyId;
        // Two versions and no more. The one in effect is the higher-numbered of those whose time has come;
        // the other slot holds the waiting version, an older one, or nothing. Publishing writes the slot
        // that is not in effect, so taking effect is never a write and nothing is ever copied.
        StoredVersion[2] slots;
    }

    /// @custom:storage-location erc7201:basket.storage.IndexRegistry
    struct RegistryStorage {
        IVaultConfig factory;
        uint32 publishDelay;
        bytes32[] ids;
        mapping(bytes32 id => Index) indexes;
    }

    // keccak256(abi.encode(uint256(keccak256("basket.storage.IndexRegistry")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant REGISTRY_STORAGE = 0x0cb72df5e712c16f02df7d588d4d4376c1ac0e18f09e3767b1d21dd34bde3500;

    // The four limits (section 6). Constants, not settings.
    uint8 internal constant MIN_ASSETS = 3;
    uint8 internal constant MAX_ASSETS = 12;
    uint16 internal constant MIN_WEIGHT_BPS = 200;
    uint16 internal constant MAX_WEIGHT_BPS = 5000;
    uint16 internal constant STEP_BPS = 50;
    uint16 internal constant SUM_BPS = 10_000;
    uint16 internal constant MAX_TURNOVER_BPS = 2000;
    /// The least the publish delay can be: a minute while only the team's money is in, 48 hours once the
    /// factory is launched. The most is there so that a slip of the hand cannot stop all publishing.
    uint32 internal constant MIN_PUBLISH_DELAY = 60;
    uint32 internal constant LAUNCHED_PUBLISH_DELAY = 172_800;
    uint32 internal constant MAX_PUBLISH_DELAY = 30 days;

    // The rules by number (fixtures/creator-limits/README.md).
    uint8 private constant FEE_NOT_ZERO = 1;
    uint8 private constant FLAGS_NOT_ZERO = 2;
    uint8 private constant TOO_FEW_ASSETS = 3;
    uint8 private constant TOO_MANY_ASSETS = 4;
    uint8 private constant ASSET_NOT_LISTED = 5;
    uint8 private constant DUPLICATE_ASSET = 6;
    uint8 private constant WEIGHT_BELOW_MIN = 7;
    uint8 private constant WEIGHT_OFF_STEP = 8;
    uint8 private constant WEIGHT_ABOVE_CEILING = 9;
    uint8 private constant WEIGHT_SUM = 10;
    uint8 private constant VERSION_PENDING = 11;
    uint8 private constant VERSION_TOO_SOON = 12;
    uint8 private constant TURNOVER_TOO_HIGH = 13;
    uint8 private constant CASH_NOT_ALLOWED = 14;

    /// The logic contract itself can never be initialised; only its proxy can, once.
    constructor() {
        _disableInitializers();
    }

    /// Runs inside the proxy's constructor.
    /// @param factory_ The platform's asset list, cash token, guardian, admin and launch switch.
    function initialize(address factory_, uint32 publishDelay_) external initializer {
        require(factory_ != address(0), ZeroAddress());
        _registry().factory = IVaultConfig(factory_);
        _setPublishDelay(publishDelay_);
    }

    // ---- authors

    /// @inheritdoc IIndexRegistry
    function create(bytes32 familyId, Weight[] calldata c, bytes32 metaHash, uint16 maxFeeBps, uint8 flags)
        external
        returns (bytes32 id)
    {
        RegistryStorage storage $ = _registry();
        id = keccak256(abi.encode(msg.sender, familyId));
        Index storage index = $.indexes[id];
        require(index.creator == address(0), IndexExists(id));
        require(maxFeeBps == 0, CreatorLimit(FEE_NOT_ZERO));
        require(flags == 0, CreatorLimit(FLAGS_NOT_ZERO));
        (bytes4 err, uint8 reason,) = _check($, index, c, 0);
        _refuse(err, reason);

        index.creator = msg.sender;
        index.familyId = familyId;
        $.ids.push(id);
        // The first version takes effect at once.
        uint32 version = _store(index, 0, c, metaHash, uint64(block.timestamp));
        emit RecipePublished(id, version, msg.sender, c, uint64(block.timestamp), 0, metaHash);
    }

    /// @inheritdoc IIndexRegistry
    function publish(bytes32 id, Weight[] calldata next, bytes32 metaHash)
        external
        returns (uint32 version, uint64 effectiveAt)
    {
        RegistryStorage storage $ = _registry();
        Index storage index = $.indexes[id];
        require(index.creator != address(0), IndexNotFound(id));
        require(msg.sender == index.creator, NotCreator(msg.sender));
        uint32 delay = _delay($);
        (bytes4 err, uint8 reason, uint16 turnoverBps) = _check($, index, next, delay);
        _refuse(err, reason);

        // Nothing is waiting, so the slot that is not in effect is empty or holds an older version.
        effectiveAt = uint64(block.timestamp) + delay;
        version = _store(index, 1 - _inEffect(index), next, metaHash, effectiveAt);
        emit RecipePublished(id, version, msg.sender, next, effectiveAt, turnoverBps, metaHash);
    }

    /// @inheritdoc IIndexRegistry
    /// @dev The factory's admin may make every guardian call, and so this one.
    function cancel(bytes32 id) external {
        RegistryStorage storage $ = _registry();
        Index storage index = $.indexes[id];
        require(index.creator != address(0), IndexNotFound(id));
        require(
            msg.sender == index.creator || msg.sender == $.factory.guardian() || msg.sender == $.factory.admin(),
            NotCreator(msg.sender)
        );
        // A version whose time has come is in effect and can no longer be cancelled.
        require(_hasWaiting(index), NothingPending(id));
        uint8 slot = 1 - _inEffect(index);
        emit VersionCancelled(id, index.slots[slot].version, msg.sender);
        delete index.slots[slot];
    }

    // ---- the factory's admin

    /// @inheritdoc IIndexRegistry
    function setPublishDelay(uint32 delay) external {
        _checkAdmin();
        _setPublishDelay(delay);
    }

    // ---- views

    /// @inheritdoc IIndexRegistry
    function active(bytes32 id) external view returns (uint32 version, Weight[] memory components) {
        Index storage index = _registry().indexes[id];
        StoredVersion storage v = index.slots[_inEffect(index)];
        return (v.version, v.components);
    }

    /// @inheritdoc IIndexRegistry
    function pending(bytes32 id)
        external
        view
        returns (uint32 version, uint64 effectiveAt, Weight[] memory components)
    {
        Index storage index = _registry().indexes[id];
        if (!_hasWaiting(index)) return (0, 0, new Weight[](0));
        StoredVersion storage v = index.slots[1 - _inEffect(index)];
        return (v.version, v.effectiveAt, v.components);
    }

    function creatorOf(bytes32 id) external view returns (address) {
        return _registry().indexes[id].creator;
    }

    /// @inheritdoc IIndexRegistry
    function indexInfo(bytes32 id) external view returns (IndexInfo memory info) {
        Index storage index = _registry().indexes[id];
        info.creator = index.creator;
        info.familyId = index.familyId;
        info.active = _load(index.slots[_inEffect(index)]);
        if (_hasWaiting(index)) info.pending = _load(index.slots[1 - _inEffect(index)]);
    }

    function indexCount() external view returns (uint256) {
        return _registry().ids.length;
    }

    function indexAt(uint256 i) external view returns (bytes32) {
        return _registry().ids[i];
    }

    /// @inheritdoc IIndexRegistry
    function previewPublish(bytes32 id, Weight[] calldata next)
        external
        view
        returns (bytes4 err, uint8 reason, uint16 turnoverBps, uint64 effectiveAt, uint64 nextAllowedAt)
    {
        RegistryStorage storage $ = _registry();
        Index storage index = $.indexes[id];
        bool first = index.creator == address(0);
        uint32 delay = first ? 0 : _delay($);
        if (!first) {
            nextAllowedAt = index.lastPublishAt + delay;
            if (_hasWaiting(index)) {
                uint64 waitsUntil = index.slots[1 - _inEffect(index)].effectiveAt;
                if (waitsUntil > nextAllowedAt) nextAllowedAt = waitsUntil;
            }
        }
        (err, reason, turnoverBps) = _check($, index, next, delay);
        if (err == 0) effectiveAt = uint64(block.timestamp) + delay;
    }

    /// @inheritdoc IIndexRegistry
    function limits() external view returns (Limits memory) {
        return Limits({
            minAssets: MIN_ASSETS,
            maxAssets: MAX_ASSETS,
            minWeightBps: MIN_WEIGHT_BPS,
            maxWeightBps: MAX_WEIGHT_BPS,
            stepBps: STEP_BPS,
            maxTurnoverBps: MAX_TURNOVER_BPS,
            publishDelay: _delay(_registry())
        });
    }

    /// @inheritdoc IIndexRegistry
    function publishDelay() external view returns (uint32) {
        return _delay(_registry());
    }

    function factory() external view returns (address) {
        return address(_registry().factory);
    }

    // ---- the limits

    /// Whether `c` may be published for `index` now. `err` is zero if it may, `NotSorted` if the list is out
    /// of order, else `CreatorLimit` with `reason`, the number of the lowest rule broken. `turnoverBps` is
    /// how much of the portfolio it moves.
    ///
    /// Rules 3 to 10 and 14 are about the list itself and hold for every version. Rules 11 to 13 are about
    /// a version that follows another; the first has nothing to wait for and nothing to be measured against.
    function _check(RegistryStorage storage $, Index storage index, Weight[] calldata c, uint32 delay)
        private
        view
        returns (bytes4 err, uint8 reason, uint16 turnoverBps)
    {
        if (c.length < MIN_ASSETS) return (CreatorLimit.selector, TOO_FEW_ASSETS, 0);
        if (c.length > MAX_ASSETS) return (CreatorLimit.selector, TOO_MANY_ASSETS, 0);
        // The rules below are only defined on a sorted list. Two equal neighbours pass: a repeated asset
        // is rule 6's to name.
        for (uint256 i = 1; i < c.length; ++i) {
            if (c[i].token < c[i - 1].token) return (NotSorted.selector, 0, 0);
        }

        // One pass over the list, keeping the lowest-numbered rule it breaks.
        IVaultConfig platform = $.factory;
        address cash = platform.cashToken();
        uint256 sum;
        for (uint256 i; i < c.length; ++i) {
            address token = c[i].token;
            uint256 bps = c[i].bps;
            if (!platform.isAsset(token)) reason = _first(reason, ASSET_NOT_LISTED);
            if (i != 0 && token == c[i - 1].token) reason = _first(reason, DUPLICATE_ASSET);
            if (bps < MIN_WEIGHT_BPS) reason = _first(reason, WEIGHT_BELOW_MIN);
            if (bps % STEP_BPS != 0) reason = _first(reason, WEIGHT_OFF_STEP);
            // Every weight is held to today's ceiling, whether it changed or not.
            uint256 ceiling = platform.asset(token).maxWeightBps;
            if (bps > (ceiling < MAX_WEIGHT_BPS ? ceiling : MAX_WEIGHT_BPS)) {
                reason = _first(reason, WEIGHT_ABOVE_CEILING);
            }
            if (token == cash) reason = _first(reason, CASH_NOT_ALLOWED);
            sum += bps;
        }
        if (sum != SUM_BPS) reason = _first(reason, WEIGHT_SUM);

        if (index.creator != address(0)) {
            if (_hasWaiting(index)) reason = _first(reason, VERSION_PENDING);
            if (block.timestamp < index.lastPublishAt + delay) reason = _first(reason, VERSION_TOO_SOON);
            // Twice the turnover, so that nothing is divided: the absolute weight changes against the
            // version in effect, an added asset counted from zero and a removed one to zero.
            uint256 moved = _moved(index.slots[_inEffect(index)].components, c);
            if (moved > 2 * uint256(MAX_TURNOVER_BPS)) reason = _first(reason, TURNOVER_TOO_HIGH);
            turnoverBps = uint16((moved + 1) / 2);
        }

        if (reason != 0) return (CreatorLimit.selector, reason, 0);
    }

    /// The lower-numbered of two broken rules, where 0 means none yet.
    function _first(uint8 found, uint8 rule) private pure returns (uint8) {
        return found == 0 || rule < found ? rule : found;
    }

    function _refuse(bytes4 err, uint8 reason) private pure {
        require(err != NotSorted.selector, NotSorted());
        require(err == bytes4(0), CreatorLimit(reason));
    }

    /// The sum of `|next - prev|` over every asset in either list. Both are sorted, so one walk does it.
    function _moved(Weight[] storage prev, Weight[] calldata next) private view returns (uint256 moved) {
        uint256 i;
        uint256 j;
        uint256 n = prev.length;
        while (i < n || j < next.length) {
            if (j == next.length || (i < n && prev[i].token < next[j].token)) {
                moved += prev[i++].bps;
            } else if (i == n || next[j].token < prev[i].token) {
                moved += next[j++].bps;
            } else {
                uint256 a = prev[i++].bps;
                uint256 b = next[j++].bps;
                moved += a > b ? a - b : b - a;
            }
        }
    }

    // ---- internals

    /// The slot of the version in effect now: of those whose time has come, the higher-numbered. A waiting
    /// version becomes the one in effect by the clock alone.
    function _inEffect(Index storage index) private view returns (uint8) {
        StoredVersion storage a = index.slots[0];
        StoredVersion storage b = index.slots[1];
        bool aLive = a.version != 0 && a.effectiveAt <= block.timestamp;
        bool bLive = b.version != 0 && b.effectiveAt <= block.timestamp;
        if (aLive && bLive) return a.version > b.version ? 0 : 1;
        return bLive ? 1 : 0;
    }

    /// Whether a version is published and not yet in effect. At most one is: none may be published while
    /// one waits.
    function _hasWaiting(Index storage index) private view returns (bool) {
        return index.slots[0].effectiveAt > block.timestamp || index.slots[1].effectiveAt > block.timestamp;
    }

    /// Writes a new version into `slot`, with the next number.
    function _store(Index storage index, uint8 slot, Weight[] calldata c, bytes32 metaHash, uint64 effectiveAt)
        private
        returns (uint32 version)
    {
        version = ++index.lastVersion;
        index.lastPublishAt = uint64(block.timestamp);
        StoredVersion storage v = index.slots[slot];
        v.version = version;
        v.effectiveAt = effectiveAt;
        v.metaHash = metaHash;
        delete v.components;
        for (uint256 i; i < c.length; ++i) {
            v.components.push(c[i]);
        }
    }

    function _load(StoredVersion storage v) private view returns (IndexVersion memory) {
        return IndexVersion({
            version: v.version,
            effectiveAt: v.effectiveAt,
            metaHash: v.metaHash,
            components: v.components
        });
    }

    /// The delay in force: the one stored, or the floor if the floor has risen above it since.
    function _delay(RegistryStorage storage $) private view returns (uint32) {
        uint32 floor = _floor($);
        return $.publishDelay > floor ? $.publishDelay : floor;
    }

    function _floor(RegistryStorage storage $) private view returns (uint32) {
        return $.factory.launched() ? LAUNCHED_PUBLISH_DELAY : MIN_PUBLISH_DELAY;
    }

    function _setPublishDelay(uint32 delay) private {
        RegistryStorage storage $ = _registry();
        require(delay >= _floor($), ParamOutOfBounds("publishDelay", delay));
        require(delay <= MAX_PUBLISH_DELAY, ParamOutOfBounds("publishDelay", delay));
        $.publishDelay = delay;
        emit PublishDelaySet(delay);
    }

    function _checkAdmin() private view {
        require(msg.sender == _registry().factory.admin(), NotAdmin(msg.sender));
    }

    /// Replacing this logic is the factory's admin's.
    function _authorizeUpgrade(address) internal view override {
        _checkAdmin();
    }

    function _registry() private pure returns (RegistryStorage storage $) {
        assembly {
            $.slot := REGISTRY_STORAGE
        }
    }
}
