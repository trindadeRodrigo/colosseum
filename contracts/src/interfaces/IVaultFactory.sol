// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IVaultConfig} from "./IVaultConfig.sol";
import {Swap, Weight} from "./Types.sol";

/// Creates the vaults and holds the platform's settings for one chain (DESIGN-VAULT.md section 3.8). A UUPS
/// proxy whose upgrade is the admin's. The settings, the roles and the guardian's switches are
/// `IVaultConfig`.
///
/// A vault is a beacon proxy at an address fixed by this factory, its owner and the plan id. The owner is
/// always the caller: there is no way to create a vault in someone else's name. The app and the keeper
/// trust only the vaults listed here (`isVault`, `vaultAt`, `vaultsOf`), never an address that merely runs
/// the same code.
interface IVaultFactory is IVaultConfig {
    event VaultCreated(address indexed vault, address indexed owner, bytes32 indexed planId);

    error VaultExists(address vault);
    /// Auto-follow is switched on by the vault's own `setAutoFollow`, which arrives with the keeper path.
    error AutoFollowUnavailable();

    /// Creates the caller's vault for the plan `salt`. With `indexId` set, `targets` must be empty and the
    /// vault copies the shared portfolio's active version, which must be `expectedVersion`.
    function createVault(
        bytes32 salt,
        Weight[] calldata targets,
        bytes32 indexId,
        uint32 expectedVersion,
        bool autoFollow
    ) external returns (address vault);

    /// The same, then pulls `cashAmount` of the cash token from the caller into the vault and runs `swaps`
    /// as the owner's first trades. The caller approves the vault's address, `vaultOf(caller, salt)`, before.
    function createVaultAndBuy(
        bytes32 salt,
        Weight[] calldata targets,
        bytes32 indexId,
        uint32 expectedVersion,
        bool autoFollow,
        uint256 cashAmount,
        Swap[] calldata swaps
    ) external returns (address vault);

    /// The vault `owner` has, or would get, for the plan `salt`. Known before it exists.
    function vaultOf(address owner, bytes32 salt) external view returns (address);

    /// Whether this factory created `vault`.
    function isVault(address vault) external view returns (bool);

    function vaultCount() external view returns (uint256);

    function vaultAt(uint256 i) external view returns (address);

    function vaultsOf(address owner) external view returns (address[] memory);

    function vaultCountOf(address owner) external view returns (uint256);

    function vaultOfAt(address owner, uint256 i) external view returns (address);

    /// The beacon every vault reads its logic from.
    function beacon() external view returns (address);
}
