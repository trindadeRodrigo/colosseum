// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IVaultConfig} from "./IVaultConfig.sol";
import {Swap, Weight} from "./Types.sol";

/// Creates the vaults and holds the platform's settings for one chain (DESIGN-VAULT.md section 3.8). A UUPS
/// proxy. `asset`, `assets`, `isAsset`, `routerPull` and `cashToken` come from `IVaultConfig`.
///
/// Events still to be declared by the slot that emits them: VaultCreated, with vault and id indexed.
interface IVaultFactory is IVaultConfig {
    /// `indexId != 0`: targets must be empty.
    function createVault(
        bytes32 salt,
        Weight[] calldata targets,
        bytes32 indexId,
        uint32 expectedVersion,
        bool autoFollow
    ) external returns (address vault);

    function createVaultAndBuy(
        bytes32 salt,
        Weight[] calldata targets,
        bytes32 indexId,
        uint32 expectedVersion,
        bool autoFollow,
        uint256 cashAmount,
        Swap[] calldata swaps
    ) external returns (address vault);

    /// Known before the vault exists.
    function vaultOf(address owner, bytes32 salt) external view returns (address);

    function vaultCount() external view returns (uint256);

    function vaultAt(uint256 i) external view returns (address);

    function vaultsOf(address owner) external view returns (address[] memory);

    function keeper() external view returns (address);

    function guardian() external view returns (address);

    function sequencerFeed() external view returns (address);

    function keeperPaused() external view returns (bool);

    function launched() external view returns (bool);

    function closedUntil() external view returns (uint64);

    /// Days since 1970, UTC.
    function closedDay(uint32 day) external view returns (bool);

    function params()
        external
        view
        returns (
            uint16 toleranceBps,
            uint16 lossCapBps,
            uint16 bandBps,
            uint32 assetCooldown,
            uint32 sessionOpen,
            uint32 sessionClose
        );

    // ---- guardian: each call can only tighten. Only the admin unpauses, shortens, removes or rotates the guardian

    function pauseKeeper() external;

    function haltAsset(address token, uint64 until) external;

    function extendClosedUntil(uint64 until) external;

    function addClosedDay(uint32 day) external;
}
