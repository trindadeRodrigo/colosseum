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

    /// `withdrawAll` left this token in the vault: its balance read or its transfer failed inside the gas
    /// the sweep gives each token. `withdraw(token, amount)` is the way to try it alone.
    event WithdrawSkipped(address indexed token);

    error NotOwner(address caller);
    error ZeroAddress();
    error CashTokenNotSet();
    error DepositShortfall(address token, uint256 expected, uint256 received);
    error GasTooLow(uint256 left, uint256 needed);

    // ---- owner only: no pause, no feed; withdraw calls neither factory nor registry and pays only the owner

    /// The cash token only (gate `DEPOSIT`): pulls `amount` of `config.cashToken()` from the owner.
    function deposit(uint256 amount) external;

    /// Any token the vault holds, deposited or sent in from outside.
    function withdraw(address token, uint256 amount) external;

    /// Every token in `tokens()`. A token that fails is skipped, returned and announced by `WithdrawSkipped`.
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

    function owner() external view returns (address);

    /// The plan this vault holds: the salt the factory derives its address from.
    function planId() external view returns (bytes32);

    /// The `IVaultConfig` this vault reads; from EVM-2 on, the factory.
    function config() external view returns (address);

    /// The tokens `withdrawAll` walks: every token that came in by a vault function.
    function tokens() external view returns (address[] memory);
}
