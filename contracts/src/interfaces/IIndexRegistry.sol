// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IndexInfo, Limits, Weight} from "./Types.sol";

/// The shared portfolios of one chain: current and pending version, and the author limits
/// (DESIGN-VAULT.md sections 3.8 and 6). A UUPS proxy. History lives in events.
///
/// Events still to be declared by the slot that emits them: VersionCancelled, with the id indexed.
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

    /// `id = keccak256(abi.encode(creator, familyId))`. `maxFeeBps` and `flags` must be zero.
    function create(bytes32 familyId, Weight[] calldata c, bytes32 metaHash, uint16 maxFeeBps, uint8 flags)
        external
        returns (bytes32 id);

    function publish(bytes32 id, Weight[] calldata next, bytes32 metaHash)
        external
        returns (uint32 version, uint64 effectiveAt);

    /// Creator or guardian, pending only.
    function cancel(bytes32 id) external;

    /// Switches to the pending version at `effectiveAt` with no transaction.
    function active(bytes32 id) external view returns (uint32 version, Weight[] memory components);

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

    function previewPublish(bytes32 id, Weight[] calldata next)
        external
        view
        returns (bytes4 err, uint16 turnoverBps, uint64 nextAllowedAt);

    function limits() external view returns (Limits memory);
}
