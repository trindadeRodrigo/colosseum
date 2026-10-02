// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Snapshot, Swap, Weight} from "./Types.sol";

/// One person's vault for one plan on one chain (DESIGN-VAULT.md section 3.8). Each vault is a beacon proxy.
///
/// Events still to be declared by the slot that emits them, with vault and id indexed: Followed, Unfollowed,
/// VersionAdopted, TargetsSet.
interface IBasketVault {
    event KeeperTrade(
        address indexed vault,
        address tokenIn,
        address tokenOut,
        uint256 spent,
        uint256 received,
        uint256 lossUsd,
        uint16 lossUsedBps
    );

    error NotOwner(address caller);
    error ZeroAddress();
    error AssetNotListed(address token);
    error DepositShortfall(address token, uint256 expected, uint256 received);

    // ---- owner only: no pause, no feed; withdraw calls neither factory nor registry and pays only the owner

    function deposit(address token, uint256 amount) external;

    function withdraw(address token, uint256 amount) external;

    function withdrawAll() external returns (address[] memory skipped);

    /// Allowlisted router; judged by the vault's own balance deltas and `minOut`.
    function ownerSwap(Swap[] calldata swaps) external;

    /// Clears the index and switches auto-follow off.
    function setTargets(Weight[] calldata targets) external;

    function acceptVersion(bytes32 indexId, uint32 expectedVersion) external;

    function setAutoFollow(bool on) external;

    /// Reserved; no builder, and the guard refuses it.
    function setOperator(address operator) external;

    function multicall(bytes[] calldata data) external returns (bytes[] memory);

    // ---- anyone, when auto-follow is on and the active version only changes weights

    function adoptVersion() external;

    // ---- keeper only; needs auto-follow on and stored targets, not an index

    function keeperSwap(Swap calldata s) external returns (uint256 spent, uint256 received);

    function snapshot() external view returns (Snapshot memory);
}
