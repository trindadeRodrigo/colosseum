// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IndexInfo, Limits, Weight} from "./Types.sol";

/// The shared portfolios of one chain: the version in effect, the one waiting, and the four author limits
/// (DESIGN-VAULT.md sections 3.8 and 6). A UUPS proxy whose upgrade is the factory's admin's. History lives
/// in events.
///
/// The rules and the number each refusal carries are in `fixtures/creator-limits/README.md`. The TypeScript
/// check, the Solana program and this contract are tested against the one file of cases beside it.
interface IIndexRegistry {
    event RecipePublished(
        bytes32 indexed id,
        uint32 indexed version,
        address indexed creator,
        Weight[] components,
        uint64 effectiveAt,
        uint16 turnoverBps,
        bytes32 metaHash
    );
    event VersionCancelled(bytes32 indexed id, uint32 indexed version, address by);
    event PublishDelaySet(uint32 delay);

    /// A version is outside the author limits. `reason` is the lowest-numbered rule it breaks:
    /// 1 FeeNotZero, 2 FlagsNotZero, 3 TooFewAssets, 4 TooManyAssets, 5 AssetNotListed, 6 DuplicateAsset,
    /// 7 WeightBelowMin, 8 WeightOffStep, 9 WeightAboveCeiling, 10 WeightSum, 11 VersionPending,
    /// 12 VersionTooSoon, 13 TurnoverTooHigh, 14 CashNotAllowed.
    error CreatorLimit(uint8 reason);
    /// The components are not in ascending order of token address.
    error NotSorted();
    error IndexExists(bytes32 id);
    error IndexNotFound(bytes32 id);
    error NotCreator(address caller);
    error NothingPending(bytes32 id);
    error NotAdmin(address caller);
    error ZeroAddress();
    /// `param` is "publishDelay".
    error ParamOutOfBounds(bytes32 param, uint256 value);

    /// Publishes version 1, which takes effect at once. `id = keccak256(abi.encode(creator, familyId))`.
    /// `maxFeeBps` and `flags` must be zero. `c` is sorted by token.
    function create(bytes32 familyId, Weight[] calldata c, bytes32 metaHash, uint16 maxFeeBps, uint8 flags)
        external
        returns (bytes32 id);

    /// The creator publishes a later version. It takes effect one publish delay later.
    function publish(bytes32 id, Weight[] calldata next, bytes32 metaHash)
        external
        returns (uint32 version, uint64 effectiveAt);

    /// The creator or the guardian takes back the version that is waiting. The wait before the next one is
    /// still counted from when it was published, and its number is not used again.
    function cancel(bytes32 id) external;

    /// The version in effect. It switches to the waiting version at `effectiveAt` with no transaction.
    /// `version` is 0 for an id that does not exist.
    function active(bytes32 id) external view returns (uint32 version, Weight[] memory components);

    /// The version that is waiting. `version` is 0 when there is none.
    function pending(bytes32 id)
        external
        view
        returns (uint32 version, uint64 effectiveAt, Weight[] memory components);

    function creatorOf(bytes32 id) external view returns (address);

    /// The creator, the family, and the active and pending versions with their components, `effectiveAt`
    /// and `metaHash`. Like `active()`, it shows the pending version as active once `effectiveAt` has passed.
    function indexInfo(bytes32 id) external view returns (IndexInfo memory);

    function indexCount() external view returns (uint256);

    function indexAt(uint256 i) external view returns (bytes32);

    /// What `publish(id, next, ..)` would answer now, without sending it. For an id that does not exist yet
    /// it answers for `create` with a zero fee and zero flags.
    /// @return err Zero when it would be accepted, else the selector it would revert with.
    /// @return reason With `CreatorLimit`, the number of the rule broken.
    /// @return turnoverBps How much of the portfolio the version moves; 0 when refused.
    /// @return effectiveAt When it would take effect; 0 when refused.
    /// @return allowedAt Set only when waiting is all it takes: the version is refused for being too soon
    /// (reason 12) and breaks no later rule, so published at or after this time with nothing else changed
    /// it is accepted. 0 otherwise, a version that is waiting included: the version in effect will change
    /// under this one, and nothing can be promised against it. The same meaning as `allowedAt` in the
    /// shared TypeScript check.
    function previewPublish(bytes32 id, Weight[] calldata next)
        external
        view
        returns (bytes4 err, uint8 reason, uint16 turnoverBps, uint64 effectiveAt, uint64 allowedAt);

    /// The numbers of the four limits, with the publish delay in force now.
    function limits() external view returns (Limits memory);

    /// Seconds between a later version being published and taking effect, and the least between two
    /// versions. At least 60, and at least 172,800 once the factory is launched.
    function publishDelay() external view returns (uint32);

    function factory() external view returns (address);

    /// The factory's admin. The delay may not go under its floor.
    function setPublishDelay(uint32 delay) external;
}
