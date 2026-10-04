// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Snapshot, Swap, Weight} from "./Types.sol";

/// One person's vault for one plan on one chain (DESIGN-VAULT.md section 3.8). Each vault is a beacon proxy
/// created by the factory, which is also the config it reads.
///
/// Built so far: the owner's path (deposit, swap, targets, withdraw) and creation. Still to come with the
/// keeper path (EVM-3): `acceptVersion`, `setAutoFollow`, `setOperator`, `adoptVersion`, `keeperSwap`,
/// `snapshot`, and the event `VersionAdopted`. The vault contract inherits this interface once it implements
/// all of it.
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

    /// One swap the owner signed, as the vault measured it on its own balances.
    event OwnerTrade(address indexed vault, address tokenIn, address tokenOut, uint256 spent, uint256 received);

    /// The vault follows the shared portfolio `indexId` and holds its version `version` as targets.
    event Followed(address indexed vault, bytes32 indexed indexId, uint32 version);

    /// The vault stopped following `indexId`.
    event Unfollowed(address indexed vault, bytes32 indexed indexId);

    /// The owner's own targets, replacing what was there.
    event TargetsSet(address indexed vault, Weight[] targets);

    /// `withdrawAll` left this token in the vault: its balance read or its transfer failed inside the gas
    /// the sweep gives each token. `withdraw(token, amount)` is the way to try it alone.
    event WithdrawSkipped(address indexed token);

    error NotOwner(address caller);
    error ZeroAddress();
    error CashTokenNotSet();
    error DepositShortfall(address token, uint256 expected, uint256 received);
    error GasTooLow(uint256 left, uint256 needed);
    /// `start` is the factory's, and only inside the transaction that created the vault.
    error NotCreating();
    error RouterNotAllowed(address router);
    /// The input was never a listed asset, the output is not listed now, or they are the same token.
    /// On Solana: `MintNotAccepted`.
    error TokenNotAccepted(address token);
    error RouterFailed(address router, bytes reason);
    error SpentTooMuch(address token, uint256 spent, uint256 maxIn);
    error ReceivedTooLittle(address token, uint256 received, uint256 minOut);
    /// A token of the vault that was neither side of the swap lost balance. On Solana: `OtherAccountDebited`.
    error OtherTokenDebited(address token, uint256 held, uint256 left);
    /// The vault's balance of a swap's input or output could not be read.
    error BalanceUnreadable(address token);
    /// An allowance from the vault was still there after the swap. On Solana: `AccountTampered`.
    error AllowanceLeft(address token, address spender, uint256 amount);
    /// 1 more than 16 targets, 2 not in ascending order of token (which also catches a token listed twice),
    /// 3 a token that is not a listed asset, 4 the cash token, 5 weights above 10,000 bps,
    /// 6 targets given together with a shared portfolio.
    error InvalidTargets(uint8 reason);
    error IndexNotFound(bytes32 indexId);
    /// The shared portfolio's active version is not the one the person reviewed.
    error VersionMismatch(bytes32 indexId, uint32 expected, uint32 active);
    error RegistryNotSet();

    // ---- the factory, once, in the transaction that creates the vault

    /// Runs inside the proxy's constructor. The caller becomes the vault's config.
    function initialize(address owner_, bytes32 planId_) external;

    /// Sets what the vault follows or its own targets, pulls `cashAmount` of the cash token from the owner
    /// and runs the owner's first swaps. Refused from anyone but the factory, and in any later transaction.
    function start(
        bytes32 indexId,
        uint32 expectedVersion,
        Weight[] calldata targets,
        uint256 cashAmount,
        Swap[] calldata swaps
    ) external;

    // ---- owner only: no pause, no feed; withdraw calls neither factory nor registry and pays only the owner

    /// The cash token only (gate `DEPOSIT`): pulls `amount` of `config.cashToken()` from the owner.
    function deposit(uint256 amount) external;

    /// Any token the vault holds, deposited or sent in from outside.
    function withdraw(address token, uint256 amount) external;

    /// Every token in `tokens()`. A token that fails is skipped, returned and announced by `WithdrawSkipped`.
    function withdrawAll() external returns (address[] memory skipped);

    /// Each swap goes through an allowed router and is judged by the vault's own balances: at most
    /// `amountIn` spent, at least `minOut` received, no other token of the vault debited, no allowance left.
    function ownerSwap(Swap[] calldata swaps) external;

    /// The owner's own targets, sorted by token: listed assets, never the cash token, at most 10,000 bps in
    /// all (the rest is cash). Clears the index and switches auto-follow off.
    function setTargets(Weight[] calldata targets) external;

    function acceptVersion(bytes32 indexId, uint32 expectedVersion) external;

    function setAutoFollow(bool on) external;

    /// Reserved; no builder, and the guard refuses it.
    function setOperator(address operator) external;

    /// Several calls in one transaction. Each inner call checks its own caller.
    function multicall(bytes[] calldata data) external returns (bytes[] memory);

    // ---- anyone, when auto-follow is on and the active version only changes weights

    function adoptVersion() external;

    // ---- keeper only; needs auto-follow on and stored targets, not an index

    function keeperSwap(Swap calldata s) external returns (uint256 spent, uint256 received);

    function snapshot() external view returns (Snapshot memory);

    function owner() external view returns (address);

    /// The plan this vault holds: the salt the factory derives its address from.
    function planId() external view returns (bytes32);

    /// The `IVaultConfig` this vault reads: the factory that created it.
    function config() external view returns (address);

    /// The tokens `withdrawAll` walks: every token that came in by a vault function.
    function tokens() external view returns (address[] memory);

    /// The targets the vault holds: its own, or the accepted version of the shared portfolio it follows.
    function targets() external view returns (Weight[] memory);

    /// The shared portfolio the vault follows (zero for none), the version it accepted, and auto-follow.
    function following() external view returns (bytes32 indexId, uint32 acceptedVersion, bool autoFollow);
}
