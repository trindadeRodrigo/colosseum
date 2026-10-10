// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Snapshot, Swap, Weight} from "./Types.sol";

/// One person's vault for one plan on one chain (DESIGN-VAULT.md section 3.8). Each vault is a beacon proxy
/// created by the factory, which is also the config it reads.
///
/// The owner's path (deposit, swap, targets, withdraw, accept, auto-follow), creation, and the keeper's
/// path (`keeperSwap`, `adoptVersion`). There is no `setOperator`: as on Solana, where `set_keeper` is not
/// built, a vault's keeper is the config's.
interface IBasketVault {
    /// One keeper trade. `lossUsd` is what it lost at the reference prices, in raw units of the cash token
    /// with cash at $1; `lossUsedBps` is the weekly counter after it, over what the vault was worth before.
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

    /// An auto-follow vault took a newer version of the portfolio it follows, with nobody's signature.
    event VersionAdopted(address indexed vault, bytes32 indexed indexId, uint32 version);

    /// The owner switched auto-follow on or off.
    event AutoFollowSet(address indexed vault, bool on);

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
    /// An owner's trade sent after the deadline it was signed with.
    error DeadlinePassed(uint64 deadline, uint64 now);

    // ---- the keeper's path. The names are the Solana program's where the rule is the same.

    /// The caller is not the config's keeper.
    error NotKeeper(address caller);
    error AutoFollowOff();
    error KeeperPaused();
    /// A keeper trade is cash for one target of the vault or one target for cash, never two assets.
    error NotCashLeg(address tokenIn, address tokenOut);
    /// The asset is already at or past its target in the direction of the trade.
    error NotTowardTarget(address token);
    /// After the trade the asset sits outside the band on the far side, or no closer to its target, or
    /// crossed it and ended more than half as far on the other side.
    error PastTarget(address token);
    /// The keeper traded this asset less than a cooldown ago.
    error Cooldown(address token, uint64 until);
    /// This trade's loss would take the weekly counter past the cap. Both in raw units of the cash token.
    error LossCapReached(uint256 used, uint256 cap);
    /// The asset has no Chainlink feed, or the feed gives no price: no answer, or one of zero or below.
    error AssetNotPriced(address token);
    /// The admin has not switched the keeper on for the asset.
    error KeeperAssetOff(address token);
    /// The feed's price is outside the asset's range.
    error PriceOutOfRange(address token, uint256 price);
    /// The price or its average is older than the asset's `maxAge`, or stamped further ahead than that.
    error PriceStale(address token, uint256 updatedAt);
    /// The price and its one-hour average are further apart than `priceDevBps` of the average.
    error PriceDeviation(address token, uint256 price, uint256 average);
    /// The chain's sequencer feed says it is down, or came back less than an hour ago.
    error SequencerDown();
    /// Outside the session, on a closed day, or before `closedUntil`: the asset trades in US hours.
    error MarketClosed(address token);
    /// The guardian halted keeper trades in the asset until `until`.
    error AssetHalted(address token, uint64 until);
    /// The issuer's pause probe says the token is paused, or does not answer.
    error AssetPaused(address token);
    /// The token's multiplier changes within a day of now, before or after, or its schedule cannot be read.
    error MultiplierWindow(address token, uint256 effectiveAt);
    /// What came in is worth less than what went out, less the tolerance, at the reference prices. In raw
    /// units of the cash token. On Solana: `ReceivedTooLittle`.
    error ValueTooLow(uint256 spentValue, uint256 receivedValue);
    /// The route spent nothing.
    error NothingTraded();
    /// The vault is worth more than the keeper's checks can measure (10^30 raw units of the cash token).
    error ValueTooLarge(uint256 value);
    /// A version brings in an asset the owner never accepted.
    error NewAssetNeedsOwner(address token);
    /// Nothing newer is in effect, or the version named is still waiting.
    error VersionNotEffective(bytes32 indexId, uint32 version);

    // ---- the factory, once, in the transaction that creates the vault

    /// Runs inside the proxy's constructor. The caller becomes the vault's config.
    function initialize(address owner_, bytes32 planId_) external;

    /// Sets what the vault follows or its own targets and auto-follow, pulls `cashAmount` of the cash token
    /// from the owner and runs the owner's first swaps. Refused from anyone but the factory, and in any
    /// later transaction.
    function start(
        bytes32 indexId,
        uint32 expectedVersion,
        Weight[] calldata targets,
        bool autoFollow,
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
    /// Refused after `deadline` (unix seconds).
    function ownerSwap(Swap[] calldata swaps, uint64 deadline) external;

    /// The owner's own targets, sorted by token: listed assets, never the cash token, at most 10,000 bps in
    /// all (the rest is cash). Clears the index and switches auto-follow off.
    function setTargets(Weight[] calldata targets) external;

    /// The owner takes the version in effect of a shared portfolio, the one the vault follows or another,
    /// if it is `expectedVersion`. The only way a new asset comes into a vault that follows.
    function acceptVersion(bytes32 indexId, uint32 expectedVersion) external;

    /// Lets the keeper trade the vault toward its targets, and anyone adopt a newer version, or stops both.
    function setAutoFollow(bool on) external;

    /// Several calls in one transaction. Each inner call checks its own caller.
    function multicall(bytes[] calldata data) external returns (bytes[] memory);

    // ---- anyone, when auto-follow is on and the active version only changes weights

    function adoptVersion() external;

    // ---- the config's keeper; needs auto-follow on

    /// Cash for one target of the vault, or one target for cash, under the checks of section 5.
    function keeperSwap(Swap calldata s) external returns (uint256 spent, uint256 received);

    function snapshot() external view returns (Snapshot memory);

    function owner() external view returns (address);

    /// The plan this vault holds: the salt the factory derives its address from.
    function planId() external view returns (bytes32);

    /// The `IVaultConfig` this vault reads: the factory that created it.
    function config() external view returns (address);

    /// The tokens `withdrawAll` walks: every token that came in by a vault function.
    function tokens() external view returns (address[] memory);

    /// Cash the vault took in through `deposit` and creation, less cash it paid out through `withdraw` and
    /// `withdrawAll`, never below zero: raw units of the cash token. What the deposit caps count.
    function netDeposited() external view returns (uint256);

    /// The targets the vault holds: its own, or the accepted version of the shared portfolio it follows.
    function targets() external view returns (Weight[] memory);

    /// The shared portfolio the vault follows (zero for none), the version it accepted, and auto-follow.
    function following() external view returns (bytes32 indexId, uint32 acceptedVersion, bool autoFollow);
}
