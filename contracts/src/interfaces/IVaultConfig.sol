// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {AssetConfig, Params} from "./Types.sol";

// Permit2, at the same address on every chain we deploy to. A router in pull mode 2 takes its input
// through it. It is never itself a router: the config refuses it and so does the vault.
address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

/// The platform's settings for one chain and who may change them: the cash token, the listed assets with
/// their price feeds, the allowed routers, the keeper's limits, and the switches the guardian holds. Nothing
/// here is a constant in the vault: on mainnet the values are the chain's dollar token, Uniswap's router and
/// Chainlink feeds, on a test network our own test cash, test exchange and test feeds.
///
/// This is the config half of `IVaultFactory` (section 3.8). The factory implements both.
///
/// Three roles. The admin sets everything and is handed over in two steps; on a mainnet it is a timelock
/// (OpenZeppelin's `TimelockController`) that a Safe proposes to, so every call marked "admin only" below
/// waits out the delay. The guardian can only tighten: pause the keeper, pause deposits, halt an asset,
/// close the market for longer. The keeper is named here and has no power in this contract.
interface IVaultConfig {
    event AssetSet(address indexed token, AssetConfig config);
    event AssetRemoved(address indexed token);
    event AssetHalted(address indexed token, uint64 until);
    event RouterSet(address indexed router, uint8 pull);
    event CashTokenSet(address indexed token);
    event AdminProposed(address indexed pendingAdmin);
    event AdminChanged(address indexed previousAdmin, address indexed newAdmin);
    event GuardianSet(address indexed guardian);
    event KeeperSet(address indexed keeper);
    event SequencerFeedSet(address indexed feed);
    event RegistrySet(address indexed registry);
    event ParamsSet(Params params);
    event KeeperPaused(address indexed by);
    event KeeperUnpaused();
    event ClosedUntilSet(uint64 until);
    event ClosedDaySet(uint32 indexed day, bool closed);
    event Launched();
    event PriceDevSet(uint16 bps);
    event DepositCapsSet(uint256 perVault, uint256 total);
    event DepositsPaused(address indexed by);
    event DepositsUnpaused();
    event SessionPriceAgeSet(uint32 age);
    /// What the config counts for a vault changed: on its deposit, or when anyone brought the count up to
    /// date after the vault paid cash out.
    event DepositCounted(address indexed vault, uint256 counted, uint256 total);

    error NotAdmin(address caller);
    error NotPendingAdmin(address caller);
    error NotGuardian(address caller);
    error ZeroAddress();
    error NoCode(address target);
    error AssetNotListed(address token);
    error AssetIsRouter(address token);
    error RouterIsAsset(address router);
    /// The address answers `allowance(address,address)` as a token does. With a token as the "router", swap
    /// data could be `approve(attacker, max)`: it moves no balance, so it passes every balance check.
    error RouterIsToken(address router);
    /// Permit2, this contract, the registry, the beacon or a vault: none of them is ever a router.
    error RouterReserved(address router);
    error CashTokenNotRemovable(address token);
    error FeedRequired(address token);
    error InvalidPull(uint8 pull);
    /// A guardian call may only tighten: the new time must be later than the one stored.
    error OnlyTighten(uint64 stored, uint64 requested);
    error AlreadyLaunched();
    /// `launch()` while an admin hand-over is proposed and not yet accepted.
    error AdminHandoverPending(address pendingAdmin);
    error RegistryAlreadySet(address registry);
    /// `param` is the field's name as ASCII, left-aligned: "source", "session", "tokenDecimals",
    /// "feedDecimals", "maxWeightBps", "maxAge", "flags", "maxPrice", "toleranceBps", "lossCapBps", "bandBps",
    /// "assetCooldown", "sessionOpen", "sessionClose", "priceDevBps", "sessionPriceAge", "vaultCap".
    error ParamOutOfBounds(bytes32 param, uint256 value);
    /// The keeper's switch on an asset with no price to value it at: no Chainlink feed, no average feed
    /// apart from it, or no price range.
    error AssetNotPriced(address token);
    /// The decimals stated for a token or a feed are not the ones it answers itself. `what` is the token,
    /// the feed or the average feed.
    error DecimalsMismatch(address what, uint8 stated, uint8 answered);
    /// The guardian stopped new money: no deposit and no first deposit at creation until the admin lifts it.
    error DepositsArePaused();
    /// The deposit would leave the vault with more cash put in, net of cash taken out, than one vault may hold.
    error VaultCapReached(address vault, uint256 counted, uint256 cap);
    /// The deposit would take the count across every vault of this factory past the total cap.
    error TotalCapReached(uint256 total, uint256 cap);
    error NotAVault(address caller);

    // ---- what a vault reads

    /// The chain's dollar token: the only token a vault takes as a deposit. Zero until the admin sets it.
    function cashToken() external view returns (address);

    /// The settings of a listed asset. A removed asset keeps its last settings, so what a vault still holds
    /// of it can be valued and sold. All zero for a token that was never listed.
    function asset(address token) external view returns (AssetConfig memory);

    /// Every listed asset.
    function assets() external view returns (address[] memory);

    /// Whether a token is on the platform's list now: it can be bought, be a target, be in a shared
    /// portfolio. Not derivable from `asset()`: a listed asset with no price source has an all-zero feed.
    function isAsset(address token) external view returns (bool);

    /// Whether a token is on the list or was once. A removed asset can still be sold and withdrawn, and can
    /// never become a router.
    function wasAsset(address token) external view returns (bool);

    /// The assets the admin took off the list.
    function removedAssets() external view returns (address[] memory);

    /// How an allowed router pulls its input: 0 not allowed, 1 direct (`transferFrom`), 2 through Permit2.
    function routerPull(address router) external view returns (uint8);

    /// The shared-portfolio registry a vault follows versions from. Zero until the admin sets it, once.
    function registry() external view returns (address);

    function keeper() external view returns (address);

    function guardian() external view returns (address);

    function sequencerFeed() external view returns (address);

    function keeperPaused() external view returns (bool);

    /// One-way. After it the publish delay of a shared portfolio is at least 172,800 s.
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

    /// How far a price may be from its one-hour average for the keeper to trade at it, in bps of the
    /// average. Zero until the admin sets it: a price must then equal its average.
    function priceDevBps() external view returns (uint16);

    /// How old a US stock's price may be, in seconds, for the keeper to trade at it while the session is
    /// open; the price must also be stamped at or after that day's session open. Zero is no such rule: only
    /// the asset's own `maxAge` holds.
    function sessionPriceAge() external view returns (uint32);

    /// The most cash one vault may have put in, net of the cash it paid out, and the most across every vault
    /// of this factory. Raw units of the cash token. Checked on every deposit; withdrawals are never capped.
    function depositCaps() external view returns (uint256 perVault, uint256 total);

    /// Whether the guardian stopped new money. It stops `deposit` and a first deposit at creation, and
    /// nothing else: a swap, a withdrawal and the keeper never read it.
    function depositsPaused() external view returns (bool);

    /// What the config counts toward the total cap: the sum of `depositedOf` over every vault.
    function totalDeposited() external view returns (uint256);

    /// What the config last counted for `vault`: its net cash deposited as of its last deposit or the last
    /// `syncDeposits` that named it.
    function depositedOf(address vault) external view returns (uint256);

    function admin() external view returns (address);

    function pendingAdmin() external view returns (address);

    // ---- a vault, about itself

    /// Called by a vault inside its deposit, with what it has now put in net of what it paid out. Refused
    /// when deposits are paused or when either cap would be passed.
    function noteDeposit(uint256 netDeposited) external;

    // ---- anyone

    /// Brings the count of each vault named down to what that vault reports now. A vault's count rises only
    /// in its own deposit; cash it paid out since is not seen until its next deposit or this call. It can
    /// only lower the total, so anyone may make it.
    function syncDeposits(address[] calldata vaults) external;

    // ---- guardian (or the admin): each call can only tighten, and none touches the owner's path

    function pauseKeeper() external;

    /// Stops keeper trades in `token` until `until`. Only a later time than the one stored is accepted.
    function haltAsset(address token, uint64 until) external;

    function extendClosedUntil(uint64 until) external;

    function addClosedDay(uint32 day) external;

    /// Stops new money into every vault of this factory. Withdrawing is untouched: it reads no config.
    function pauseDeposits() external;

    // ---- admin only: unpause, shorten, remove, rotate

    function setAsset(address token, AssetConfig calldata cfg) external;

    /// Takes an asset off the list. It can no longer be bought, named as a target or put in a shared
    /// portfolio. Vaults that hold it can still sell it and withdraw it. The cash token cannot be removed.
    function removeAsset(address token) external;

    function setRouter(address router, uint8 pull) external;

    function setCashToken(address token) external;

    function setRegistry(address registry_) external;

    function setKeeper(address keeper_) external;

    function setGuardian(address guardian_) external;

    function setSequencerFeed(address feed) external;

    function setParams(Params calldata p) external;

    /// At most 1,000 bps, the bound of the Solana program's `twap_dev_bps`.
    function setPriceDevBps(uint16 bps) external;

    function unpauseKeeper() external;

    function unpauseDeposits() external;

    /// Both caps in raw units of the cash token, the per-vault cap at most the total. `type(uint256).max`
    /// for both is no cap, which is how a new factory starts.
    function setDepositCaps(uint256 perVault, uint256 total) external;

    /// At most 26 hours. Zero switches the rule off.
    function setSessionPriceAge(uint32 age) external;

    /// Sets an asset's halt to any time, earlier ones included: the admin's way to lift or shorten a halt.
    function setHalt(address token, uint64 until) external;

    function setClosedUntil(uint64 until) external;

    function setClosedDay(uint32 day, bool closed) external;

    /// One-way: the product is open to the public. Raises the floor of the publish delay to 172,800 s.
    /// Refused while a hand-over of the admin or of the beacon is half done.
    function launch() external;

    function proposeAdmin(address next) external;

    function acceptAdmin() external;
}
