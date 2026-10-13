// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {TransientSlot} from "@openzeppelin/contracts/utils/TransientSlot.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {MulticallUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/MulticallUpgradeable.sol";
import {IBasketVault} from "./interfaces/IBasketVault.sol";
import {IIndexRegistry} from "./interfaces/IIndexRegistry.sol";
import {IPermit2} from "./interfaces/IPermit2.sol";
import {IVaultConfig, PERMIT2} from "./interfaces/IVaultConfig.sol";
import {AssetConfig, Params, Snapshot, Swap, Weight} from "./interfaces/Types.sol";

/// One person's vault for one plan on one chain. The logic contract behind every vault's beacon proxy.
///
/// The owner's path and creation (EVM-1, EVM-2): deposit the cash token, swap through an allowed router,
/// set targets, and withdraw in kind to the owner. The keeper's path (EVM-3): accept a version and switch
/// auto-follow (the owner), adopt a version (anyone, for a vault that follows), and the keeper's trade.
///
/// Rules that hold here and must keep holding:
/// - A vault is created by its factory and by nothing else: the proxy's constructor runs `initialize`, the
///   caller becomes the config, and `start` answers only that caller and only in the same transaction.
/// - Money comes in as the chain's cash token only (gate `DEPOSIT`). The vault reads which token that is
///   from its config each time. A token sent in from outside cannot be stopped: it is not in `tokens`, and
///   the owner takes it out with `withdraw`.
/// - Tokens leave only by the owner's call (I1): to the owner, or as the input of a swap the owner signed,
///   never more than its `amountIn`. No function takes a recipient, the owner is set once and cannot be
///   changed, and there is no `fallback` and no `receive`.
/// - A swap is judged by what the vault's own balances did, never by what the router answers: spent at
///   most `amountIn`, received at least `minOut`, no other token of the vault debited.
/// - No allowance from the vault outlives the swap that gave it, on the token or in Permit2 (I3). The vault
///   has no `isValidSignature`, so nobody can sign an allowance in its name.
/// - Withdrawing reads no feed and calls neither the config, the factory nor the registry (I4). Only a
///   beacon upgrade can block it. No pause reaches it: the guardian's two switches stop the keeper and new
///   deposits, and neither is read on the way out.
/// - New money is counted and capped (the deposit caps): the vault keeps what came in as cash less what
///   left as cash, tells the config that number inside each deposit, and the config refuses a deposit that
///   would pass the cap of one vault or of all of them. A withdrawal lowers the vault's own number and tells
///   nobody.
/// - `withdrawAll` never leaves a token behind for lack of gas: short of gas it fails as a whole.
/// - One reentrancy guard covers every function that changes state. `multicall` is the one exception: it
///   only calls back into the vault, and each inner call takes the guard itself.
/// - Amounts are raw token units. The vault never calls `decimals()`; the config states them.
/// - The keeper can call one function, `keeperSwap`, and the checks of section 5 bound what it can lose:
///   each trade at most the tolerance at the reference prices, a week at most the loss cap (twice it when
///   spread to follow the counter's drain), and only toward the targets the owner chose. Tokens never leave
///   by the keeper except as a trade's input. Nothing on the keeper's path is read by the owner's: a pause,
///   a dead feed or a closed market stops the keeper and never the owner.
/// - State lives in one ERC-7201 namespace. Later slots append to `VaultStorage`, never reorder it, and
///   inherit only bases that are stateless or namespaced.
contract BasketVault is Initializable, ReentrancyGuardTransient, MulticallUpgradeable, IBasketVault {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;
    using TransientSlot for *;

    /// @custom:storage-location erc7201:basket.storage.BasketVault
    struct VaultStorage {
        address owner;
        IVaultConfig config;
        bytes32 planId;
        // Every token that came in by a vault function: the cash token, and both sides of every swap.
        // `withdrawAll` walks this list and nothing else.
        EnumerableSet.AddressSet tokens;
        // ---- appended by EVM-2
        // The shared portfolio this vault follows and the version it holds as targets. Zero for none.
        bytes32 indexId;
        uint32 acceptedVersion;
        // Off until the owner switches it on (EVM-3). Nothing here sets it.
        bool autoFollow;
        // Reserved (section 3.8). Nothing here sets it. It shares a slot with the two fields above: bits 0 to
        // 31 the version, 32 to 39 auto-follow, 40 to 199 the operator.
        address operator;
        // Sorted by token. The owner's own, or a copy of the followed portfolio's accepted version, with a
        // target of zero for an asset a later version dropped while the vault still held it.
        Weight[] targets;
        // ---- appended by EVM-3
        // When the keeper last traded each asset (check 6).
        mapping(address token => uint64) lastKeeperAt;
        // The weekly loss counter (check 7): raw units of the cash token, cash at $1, and when it was last
        // written. What is left of it falls in a straight line to nothing over seven days from then.
        uint256 lossAccum;
        uint64 lossTs;
        // ---- appended by the mainnet setup
        // What the deposit caps count: cash in through `deposit` and creation, less cash out through
        // `withdraw` and `withdrawAll`, never below zero. Raw units of `depositToken`.
        uint256 netDeposited;
        // The cash token as of the vault's last deposit. Kept here so that a withdrawal can tell cash from
        // any other token without asking the config.
        address depositToken;
    }

    // keccak256(abi.encode(uint256(keccak256("basket.storage.BasketVault")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant VAULT_STORAGE = 0xa3206dd01d46554bcca9bfac00567bdedfa0efb64d962bf4bf1458722c932700;

    /// The gas `withdrawAll` gives one token's balance read and one token's transfer. Measured on a fork of
    /// Robinhood Chain (`test/fork/RobinhoodFork.t.sol`): the real stock token, a beacon proxy, takes 13,841
    /// for a cold read and 47,670 for a transfer that writes a fresh balance; the real dollar token 10,678
    /// and 39,930. The caps are six to seven times that, and bound what a token that burns its gas can cost
    /// the sweep. A token that needs more is skipped by the sweep and still leaves through `withdraw`,
    /// which is uncapped.
    uint256 internal constant SWEEP_BALANCE_GAS = 100_000;
    uint256 internal constant SWEEP_TRANSFER_GAS = 300_000;
    /// What must be left before each token so that both calls get their full cap: a call keeps back 1/64 of
    /// the gas, so (100,000 + 300,000) * 64 / 63 = 406,350, plus room for the loop's own work.
    uint256 internal constant SWEEP_RESERVE = 420_000;

    /// The transient slot that says the vault is being created: set by `initialize`, cleared by `start`,
    /// and gone when the creating transaction ends.
    // keccak256(abi.encode(uint256(keccak256("basket.transient.BasketVault.creating")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant CREATING = 0x40f19175d43003be909096bdf48d7d52db8f0e5be4f0f7ba482c4b8d6be6f300;

    uint8 internal constant PULL_PERMIT2 = 2;
    uint256 internal constant BPS = 10_000;
    /// The most targets a vault holds, as on Solana. A shared portfolio has at most 12.
    uint256 internal constant MAX_TARGETS = 16;
    /// Marks a token whose balance could not be read. No token has this balance.
    uint256 private constant UNREADABLE = type(uint256).max;

    /// Bit 0 of an asset's `flags`: the admin has switched the keeper on for it.
    uint8 internal constant KEEPER_ON = 1;
    /// The window of the loss cap.
    uint256 internal constant LOSS_WINDOW = 7 days;
    /// A keeper trade stays a day away from a change of the token's multiplier, before and after.
    uint256 internal constant MULTIPLIER_WINDOW = 1 days;
    /// How long after the sequencer comes back up its chain's prices are not trusted.
    uint256 internal constant SEQUENCER_GRACE = 1 hours;
    /// The most a vault may be worth for the keeper to trade it, in raw units of the cash token: 10^30, a
    /// trillion dollars of an 18-decimal dollar. Every product the checks form is a part of a vault's value
    /// times another part, times at most 2 * 10^4, so under this bound none comes near 2^256.
    uint256 internal constant MAX_VALUE = 1e30;
    /// `latestRoundData()` of a Chainlink aggregator.
    bytes4 private constant LATEST_ROUND_DATA = 0xfeaf968c;

    /// What a keeper trade knows before the router is called.
    struct Leg {
        address asset;
        address cash;
        bool buying;
        uint16 targetBps;
        uint8 cashDecimals;
        AssetConfig config;
        Params params;
        /// The asset's price, in its feed's units.
        uint256 price;
        /// What the vault's other targets are worth, in raw units of the cash token.
        uint256 others;
        uint256 assetValue;
        uint256 vaultValue;
        /// When today's session opened and how old a stock's price may be in it; both zero when the rule is
        /// off or the clock is outside the session.
        uint256 sessionOpenAt;
        uint32 sessionAge;
    }

    modifier onlyOwner() {
        require(msg.sender == _vault().owner, IBasketVault.NotOwner(msg.sender));
        _;
    }

    /// The logic contract itself can never be initialised; only a proxy can, once.
    constructor() {
        _disableInitializers();
    }

    /// Runs inside the proxy's constructor, so a vault never exists without an owner. The caller, the
    /// factory, becomes the config the vault reads: a vault cannot be told a config that did not create it.
    /// @param owner_ The person. Fixed for the life of the vault.
    /// @param planId_ The plan this vault holds: the salt the factory derives the vault's address from.
    function initialize(address owner_, bytes32 planId_) external initializer {
        require(owner_ != address(0), IBasketVault.ZeroAddress());
        VaultStorage storage $ = _vault();
        $.owner = owner_;
        $.planId = planId_;
        $.config = IVaultConfig(msg.sender);
        CREATING.asBoolean().tstore(true);
    }

    /// The rest of creation, in the factory's next call: what the vault follows or its own targets, the
    /// first cash from the owner, and the owner's first swaps. The factory passes on what the owner sent it
    /// and nothing else.
    ///
    /// It answers only the factory and only while the creating transaction lasts: the mark `initialize` left
    /// is in transient storage, so it is cleared here and cannot exist in any later transaction. After that
    /// the factory has no way into a vault at all.
    function start(
        bytes32 indexId,
        uint32 expectedVersion,
        Weight[] calldata targets_,
        bool autoFollow_,
        uint256 cashAmount,
        Swap[] calldata swaps
    ) external nonReentrant {
        VaultStorage storage $ = _vault();
        require(msg.sender == address($.config) && CREATING.asBoolean().tload(), IBasketVault.NotCreating());
        CREATING.asBoolean().tstore(false);

        if (indexId != bytes32(0)) {
            require(targets_.length == 0, IBasketVault.InvalidTargets(6));
            _follow($, indexId, expectedVersion);
        } else {
            _setOwnTargets($, targets_);
        }
        if (autoFollow_) _setAutoFollow($, true);
        if (cashAmount != 0) _pullCash($, $.owner, cashAmount);
        if (swaps.length != 0) _swapAll($, swaps);
    }

    // ---- owner only

    /// Pulls `amount` of the chain's cash token from the owner, and no other token.
    function deposit(uint256 amount) external onlyOwner nonReentrant {
        _pullCash(_vault(), msg.sender, amount);
    }

    /// Trades through allowed routers, one swap after another. All of them pass or none does.
    ///
    /// The input must be a token that is or was a listed asset, the output one that is listed now: a removed
    /// asset can be sold and not bought. Both join `tokens`. For each swap the vault approves exactly
    /// `amountIn` (to the router, or to Permit2 and inside it to the router, as the config says the router
    /// pulls), calls the router with `data`, takes the approval back and checks it is gone, then reads its
    /// own balances: at most `amountIn` of the input left, at least `minOut` of the output arrived, and no
    /// other token in `tokens` went down.
    ///
    /// Refused after `deadline`: a trade signed and not sent in time would otherwise land whenever its
    /// nonce is next used, at whatever the market then gives above `minOut`.
    function ownerSwap(Swap[] calldata swaps, uint64 deadline) external onlyOwner nonReentrant {
        require(block.timestamp <= deadline, DeadlinePassed(deadline, uint64(block.timestamp)));
        _swapAll(_vault(), swaps);
    }

    /// Replaces the vault's targets with the owner's own and stops following a shared portfolio. Targets
    /// are listed assets in ascending order of token, never the cash token, adding up to at most 10,000 bps:
    /// what is left is cash. An empty list means all cash.
    function setTargets(Weight[] calldata targets_) external onlyOwner nonReentrant {
        VaultStorage storage $ = _vault();
        bytes32 followed = $.indexId;
        if (followed != bytes32(0)) {
            $.indexId = bytes32(0);
            $.acceptedVersion = 0;
            emit IBasketVault.Unfollowed(address(this), followed);
        }
        $.autoFollow = false;
        _setOwnTargets($, targets_);
    }

    /// Takes the version in effect of a shared portfolio, the one the vault follows or another, as the
    /// targets: the owner's consent to that version's weights, by its number. The number of the version that
    /// waits is `VersionNotEffective`, any other but the one in effect `VersionMismatch`. An asset the version
    /// drops and the vault still holds stays as a target of zero, for the keeper to sell. Auto-follow is left
    /// as it was.
    function acceptVersion(bytes32 indexId, uint32 expectedVersion) external onlyOwner nonReentrant {
        VaultStorage storage $ = _vault();
        (uint32 waiting,,) = _registry($).pending(indexId);
        require(waiting == 0 || waiting != expectedVersion, VersionNotEffective(indexId, expectedVersion));
        bytes32 before = $.indexId;
        if (before != bytes32(0) && before != indexId) emit Unfollowed(address(this), before);
        _follow($, indexId, expectedVersion);
    }

    /// Lets the keeper trade this vault toward its targets and anyone adopt a newer version of the
    /// portfolio it follows, or stops both.
    function setAutoFollow(bool on) external onlyOwner nonReentrant {
        _setAutoFollow(_vault(), on);
    }

    // ---- anyone

    /// Moves an auto-follow vault to the version in effect of the portfolio it follows, when that version
    /// only changes weights among assets the owner accepted: each of its assets is a target above zero.
    /// Holding a token is not accepting it. It is a keeper path: the guardian's pause stops it.
    function adoptVersion() external nonReentrant {
        VaultStorage storage $ = _vault();
        require($.autoFollow, AutoFollowOff());
        require(!$.config.keeperPaused(), KeeperPaused());
        bytes32 indexId = $.indexId;
        require(indexId != bytes32(0), IndexNotFound(indexId));
        (uint32 version, Weight[] memory components) = _registry($).active(indexId);
        // Nothing newer than what the vault holds is in effect: a version that waits is not.
        require(version > $.acceptedVersion, VersionNotEffective(indexId, version));
        for (uint256 i; i < components.length; ++i) {
            require(_accepts($, components[i].token), NewAssetNeedsOwner(components[i].token));
        }
        _take($, components);
        $.acceptedVersion = version;
        emit VersionAdopted(address(this), indexId, version);
    }

    // ---- the keeper

    /// One trade toward the targets: cash for one target, or one target for cash, through an allowed router.
    /// Everything the owner's swap checks around the router's call is checked here too, and then the rules
    /// of section 5, in the Solana program's order: the keeper, auto-follow, the pause, cash on one side, the
    /// asset a target, the cooldown, the token's own state and the market, the price reference of every
    /// target the vault holds, the largest value measured, the direction; after the call the amount spent
    /// (something, and at most `amountIn`), `minOut`, the value received, the band, the distance from the
    /// target and the weekly loss cap.
    function keeperSwap(Swap calldata s) external nonReentrant returns (uint256 spent, uint256 received) {
        VaultStorage storage $ = _vault();
        IVaultConfig cfg = $.config;
        Leg memory leg = _beforeLeg($, cfg, s);

        uint8 pull = cfg.routerPull(s.router);
        require(pull != 0, RouterNotAllowed(s.router));
        $.tokens.add(leg.asset);
        $.tokens.add(leg.cash);
        require(
            s.router != address(this) && s.router != PERMIT2 && !$.tokens.contains(s.router), RouterNotAllowed(s.router)
        );
        address[] memory list = $.tokens.values();
        uint256[] memory held = new uint256[](list.length);
        for (uint256 j; j < list.length; ++j) {
            held[j] = _held(list[j]);
        }
        (spent, received) = _trade(s, pull, list, held);
        // A trade that spends nothing must not use up the asset's one trade of the cooldown.
        require(spent != 0, NothingTraded());
        _afterLeg($, leg, s, spent, received);
    }

    /// Sends `amount` of any token the vault holds to the owner, whether it was deposited or sent in from
    /// outside. Passes on all the gas it is given, and fails if the token does.
    function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(_vault().owner, amount);
        _countOut(_vault(), token, amount);
    }

    /// Sends the whole balance of every token in `tokens` to the owner. A token that reverts, answers
    /// `false`, or needs more gas than the sweep gives one token is skipped, returned and announced by
    /// `WithdrawSkipped`, so one frozen token cannot hold the others (A9).
    ///
    /// A token is never skipped because the caller sent too little gas: before each token the call checks
    /// that both of that token's calls can have their full cap, and fails as a whole if not. So the outcome
    /// for each token is the same at every gas limit the call succeeds at, and a gas estimate cannot land on
    /// a run that leaves a healthy token behind.
    function withdrawAll() external onlyOwner nonReentrant returns (address[] memory skipped) {
        VaultStorage storage $ = _vault();
        address to = $.owner;
        address cash = $.depositToken;
        address[] memory list = $.tokens.values();
        skipped = new address[](list.length);
        uint256 n;
        uint256 cashOut;
        for (uint256 i; i < list.length; ++i) {
            require(gasleft() >= SWEEP_RESERVE, IBasketVault.GasTooLow(gasleft(), SWEEP_RESERVE));
            (bool readable, uint256 held) = _tryBalanceOf(list[i]);
            if (readable && held == 0) continue;
            if (!readable || !_tryTransfer(list[i], to, held)) {
                skipped[n++] = list[i];
                emit IBasketVault.WithdrawSkipped(list[i]);
            } else if (list[i] == cash) {
                cashOut = held;
            }
        }
        // With nothing left behind the vault holds none of what it took in, in whatever form it left. With
        // a token skipped, only the cash that left is counted out.
        if (n == 0) {
            if ($.netDeposited != 0) $.netDeposited = 0;
        } else if (cashOut != 0) {
            _countOut($, cash, cashOut);
        }
        assembly ("memory-safe") {
            mstore(skipped, n)
        }
    }

    /// Several of the vault's own calls in one transaction. Outside the reentrancy guard on purpose: it only
    /// calls back into the vault, and each inner call takes the guard and checks its own caller.
    function multicall(bytes[] calldata data)
        public
        override(MulticallUpgradeable, IBasketVault)
        returns (bytes[] memory)
    {
        return super.multicall(data);
    }

    // ---- views

    function owner() external view returns (address) {
        return _vault().owner;
    }

    function planId() external view returns (bytes32) {
        return _vault().planId;
    }

    function config() external view returns (address) {
        return address(_vault().config);
    }

    /// @inheritdoc IBasketVault
    function netDeposited() external view returns (uint256) {
        return _vault().netDeposited;
    }

    /// The tokens `withdrawAll` walks, in the order they first came in.
    function tokens() external view returns (address[] memory) {
        return _vault().tokens.values();
    }

    /// The targets the vault holds, sorted by token.
    function targets() external view returns (Weight[] memory) {
        return _vault().targets;
    }

    /// The shared portfolio the vault follows (zero for none), the version it accepted, and auto-follow.
    function following() external view returns (bytes32 indexId, uint32 acceptedVersion, bool autoFollow) {
        VaultStorage storage $ = _vault();
        return ($.indexId, $.acceptedVersion, $.autoFollow);
    }

    /// One read of the vault for the app and for agents. `tokens` are the targets in order, then the cash
    /// token with what the targets leave of 10,000 bps. A balance that cannot be read is zero, and so is a
    /// price whose feed does not answer: this is a view of the feeds as they stand, not the keeper's
    /// reference, and it never reverts on a token or a feed. `lossUsedBps` is what is left of the weekly
    /// counter over what the priced holdings are worth.
    function snapshot() external view returns (Snapshot memory snap) {
        VaultStorage storage $ = _vault();
        IVaultConfig cfg = $.config;
        Weight[] memory list = $.targets;
        uint256 n = list.length + 1;
        snap.owner = $.owner;
        snap.indexId = $.indexId;
        snap.acceptedVersion = $.acceptedVersion;
        snap.autoFollow = $.autoFollow;
        snap.planId = $.planId;
        snap.tokens = new address[](n);
        snap.targetBps = new uint16[](n);
        snap.balances = new uint256[](n);
        snap.prices = new uint256[](n);
        snap.priceUpdatedAt = new uint64[](n);
        snap.lastKeeperAt = new uint64[](n);

        address cash = cfg.cashToken();
        uint256 cashDecimals = cfg.asset(cash).tokenDecimals;
        uint256 left = BPS;
        uint256 worth;
        for (uint256 i; i < n; ++i) {
            address token = i < list.length ? list[i].token : cash;
            uint256 held = _held(token);
            held = held == UNREADABLE ? 0 : held;
            snap.tokens[i] = token;
            snap.balances[i] = held;
            if (i == list.length) {
                snap.targetBps[i] = uint16(left);
                snap.prices[i] = 1e18;
                worth += held * 1e18 / 10 ** cashDecimals;
                continue;
            }
            snap.targetBps[i] = list[i].bps;
            left -= list[i].bps;
            snap.lastKeeperAt[i] = $.lastKeeperAt[token];
            AssetConfig memory a = cfg.asset(token);
            (uint256 price, uint256 stamp) = a.feed == address(0) ? (0, 0) : _readFeed(a.feed);
            if (price == 0 || price > type(uint128).max) continue;
            snap.prices[i] = price * 1e18 / 10 ** a.feedDecimals;
            snap.priceUpdatedAt[i] = uint64(Math.min(stamp, type(uint64).max));
            worth += Math.mulDiv(held, snap.prices[i], 10 ** a.tokenDecimals);
        }
        // The counter is in raw units of cash; `worth` in dollars at 18 decimals.
        uint256 used = _lossLeft($) * 1e18 / 10 ** cashDecimals;
        snap.lossUsedBps = worth == 0 ? 0 : uint16(Math.min(used * BPS / worth, type(uint16).max));
    }

    // ---- internals

    /// Pulls the cash token from `from`: the owner, as the caller of `deposit` or as stored. The vault's
    /// balance must rise by at least `amount`: a token that skims a fee on transfer is refused, because
    /// every later check (a swap's minimum, the keeper's value check) assumes a transfer moves what it says.
    function _pullCash(VaultStorage storage $, address from, uint256 amount) private {
        address cash = $.config.cashToken();
        require(cash != address(0), IBasketVault.CashTokenNotSet());
        $.tokens.add(cash);

        uint256 before = IERC20(cash).balanceOf(address(this));
        IERC20(cash).safeTransferFrom(from, address(this), amount);
        uint256 received = IERC20(cash).balanceOf(address(this)) - before;
        require(received >= amount, IBasketVault.DepositShortfall(cash, amount, received));

        // The count is in units of one cash token. Should the admin ever name another, it starts again.
        if ($.depositToken != cash) {
            $.depositToken = cash;
            $.netDeposited = 0;
        }
        uint256 net = $.netDeposited + received;
        $.netDeposited = net;
        // The config refuses here when deposits are paused or a cap would be passed.
        $.config.noteDeposit(net);
    }

    /// Lowers the count of cash put in by cash that left, down to zero and no further: cash a sale brought
    /// in can leave too. No call is made: the token is compared with the one the vault remembers.
    function _countOut(VaultStorage storage $, address token, uint256 amount) private {
        if (token != $.depositToken) return;
        uint256 net = $.netDeposited;
        if (net != 0) $.netDeposited = net > amount ? net - amount : 0;
    }

    /// Copies the active version of a shared portfolio as the vault's targets, if it is the version the
    /// person reviewed. A create signed against version N that lands after N+1 took effect fails here (A18).
    function _follow(VaultStorage storage $, bytes32 indexId, uint32 expectedVersion) private {
        (uint32 version, Weight[] memory components) = _registry($).active(indexId);
        require(version != 0, IBasketVault.IndexNotFound(indexId));
        require(version == expectedVersion, IBasketVault.VersionMismatch(indexId, expectedVersion, version));

        _take($, components);
        $.indexId = indexId;
        $.acceptedVersion = version;
        emit IBasketVault.Followed(address(this), indexId, version);
    }

    function _registry(VaultStorage storage $) private view returns (IIndexRegistry) {
        address registry = $.config.registry();
        require(registry != address(0), IBasketVault.RegistryNotSet());
        return IIndexRegistry(registry);
    }

    /// Takes a version's weights as the targets. An asset the version drops and the vault still holds stays
    /// as a target of zero, so the keeper can sell it; one it holds nothing of goes. A balance that cannot be
    /// read counts as held. Both lists are sorted by token, and so is the result. More than 16 is
    /// `InvalidTargets(1)`: the owner sells a leftover first.
    function _take(VaultStorage storage $, Weight[] memory next) private {
        Weight[] memory old = $.targets;
        delete $.targets;
        uint256 j;
        for (uint256 i; i < old.length; ++i) {
            address token = old[i].token;
            while (j < next.length && next[j].token < token) {
                $.targets.push(next[j++]);
            }
            if (j < next.length && next[j].token == token) continue;
            if (_held(token) != 0) $.targets.push(Weight(token, 0));
        }
        while (j < next.length) {
            $.targets.push(next[j++]);
        }
        require($.targets.length <= MAX_TARGETS, InvalidTargets(1));
    }

    /// Whether the owner accepted `token`: it is a target above zero.
    function _accepts(VaultStorage storage $, address token) private view returns (bool) {
        (bool found, uint16 bps) = _targetOf($, token);
        return found && bps != 0;
    }

    function _targetOf(VaultStorage storage $, address token) private view returns (bool found, uint16 bps) {
        Weight[] storage list = $.targets;
        for (uint256 i; i < list.length; ++i) {
            if (list[i].token == token) return (true, list[i].bps);
        }
    }

    function _setAutoFollow(VaultStorage storage $, bool on) private {
        $.autoFollow = on;
        emit AutoFollowSet(address(this), on);
    }

    function _setOwnTargets(VaultStorage storage $, Weight[] calldata list) private {
        require(list.length <= MAX_TARGETS, IBasketVault.InvalidTargets(1));
        IVaultConfig cfg = $.config;
        address cash = cfg.cashToken();
        uint256 total;
        address last;
        delete $.targets;
        for (uint256 i; i < list.length; ++i) {
            address token = list[i].token;
            require(i == 0 || token > last, IBasketVault.InvalidTargets(2));
            require(cfg.isAsset(token), IBasketVault.InvalidTargets(3));
            require(token != cash, IBasketVault.InvalidTargets(4));
            total += list[i].bps;
            last = token;
            $.targets.push(list[i]);
        }
        require(total <= BPS, IBasketVault.InvalidTargets(5));
        emit IBasketVault.TargetsSet(address(this), list);
    }

    /// Checks every swap and admits its tokens before anything is approved or called, then runs them in
    /// order against one running record of the vault's balances.
    function _swapAll(VaultStorage storage $, Swap[] calldata swaps) private {
        IVaultConfig cfg = $.config;
        uint8[] memory pulls = new uint8[](swaps.length);
        for (uint256 i; i < swaps.length; ++i) {
            Swap calldata s = swaps[i];
            require(cfg.wasAsset(s.tokenIn), IBasketVault.TokenNotAccepted(s.tokenIn));
            require(s.tokenOut != s.tokenIn && cfg.isAsset(s.tokenOut), IBasketVault.TokenNotAccepted(s.tokenOut));
            $.tokens.add(s.tokenIn);
            $.tokens.add(s.tokenOut);

            pulls[i] = cfg.routerPull(s.router);
            require(pulls[i] != 0, IBasketVault.RouterNotAllowed(s.router));
        }
        // The config keeps these out of its router list. The vault does not take its word for it: with a
        // token it holds, Permit2 or itself as the router, `data` could be an approval. Checked once every
        // token of the batch is in `tokens`, so that a token a later swap brings in is seen too.
        for (uint256 i; i < swaps.length; ++i) {
            address router = swaps[i].router;
            require(
                router != address(this) && router != PERMIT2 && !$.tokens.contains(router),
                IBasketVault.RouterNotAllowed(router)
            );
        }

        address[] memory list = $.tokens.values();
        uint256[] memory held = new uint256[](list.length);
        for (uint256 j; j < list.length; ++j) {
            held[j] = _held(list[j]);
        }
        for (uint256 i; i < swaps.length; ++i) {
            _swap(swaps[i], pulls[i], list, held);
        }
    }

    /// One swap of the owner's. `held` is what the vault had of each token in `list` before it, and is
    /// updated to what it has after.
    function _swap(Swap calldata s, uint8 pull, address[] memory list, uint256[] memory held) private {
        (uint256 spent, uint256 received) = _trade(s, pull, list, held);
        emit IBasketVault.OwnerTrade(address(this), s.tokenIn, s.tokenOut, spent, received);
    }

    /// Approves, calls the router, takes the approval back, and judges the trade by the vault's own
    /// balances: at most `amountIn` spent, at least `minOut` received, no other token of `list` lower.
    /// `held` is what the vault had of each token before, and is updated to what it has after.
    function _trade(Swap calldata s, uint8 pull, address[] memory list, uint256[] memory held)
        private
        returns (uint256 spent, uint256 received)
    {
        _approve(s.tokenIn, s.router, pull, s.amountIn);
        (bool ok, bytes memory reason) = s.router.call(s.data);
        require(ok, IBasketVault.RouterFailed(s.router, reason));
        _revoke(s.tokenIn, s.router, pull);

        for (uint256 j; j < list.length; ++j) {
            address token = list[j];
            uint256 was = held[j];
            uint256 left = _held(token);
            held[j] = left;
            bool traded = token == s.tokenIn || token == s.tokenOut;
            // Both sides of the swap must be readable before and after: the checks below are on them.
            require(!traded || (was != UNREADABLE && left != UNREADABLE), IBasketVault.BalanceUnreadable(token));
            if (token == s.tokenIn) {
                spent = was > left ? was - left : 0;
                require(spent <= s.amountIn, IBasketVault.SpentTooMuch(token, spent, s.amountIn));
            } else if (token == s.tokenOut) {
                received = left > was ? left - was : 0;
                require(received >= s.minOut, IBasketVault.ReceivedTooLittle(token, received, s.minOut));
            } else if (was != UNREADABLE) {
                // A token that could not be read before the swap (frozen by its issuer, say) is left out,
                // so that it cannot hold up trades in the others. One that could be read must still be
                // readable, and not lower.
                require(left != UNREADABLE && left >= was, IBasketVault.OtherTokenDebited(token, was, left));
            }
        }
    }

    // ---- the keeper's rules (DESIGN-VAULT.md section 5)

    /// Checks 1, 2, 6, 8, 9, 10 and 11 and the direction of check 5, and values the vault for the rest.
    function _beforeLeg(VaultStorage storage $, IVaultConfig cfg, Swap calldata s) private returns (Leg memory leg) {
        // Check 1. There is no operator of a vault's own: as on Solana, where `set_keeper` is not built.
        require(msg.sender == cfg.keeper(), NotKeeper(msg.sender));
        require($.autoFollow, AutoFollowOff());
        // Check 11.
        require(!cfg.keeperPaused(), KeeperPaused());

        // Check 2. Cash on one side, and one side only: the other is a target of the vault. An asset is
        // bought only while it is listed; one taken off the list can still be sold.
        leg.cash = cfg.cashToken();
        bool inIsCash = s.tokenIn == leg.cash;
        require(leg.cash != address(0) && inIsCash != (s.tokenOut == leg.cash), NotCashLeg(s.tokenIn, s.tokenOut));
        leg.buying = inIsCash;
        leg.asset = inIsCash ? s.tokenOut : s.tokenIn;
        bool isTarget;
        (isTarget, leg.targetBps) = _targetOf($, leg.asset);
        require(isTarget, TokenNotAccepted(leg.asset));
        require(!leg.buying || cfg.isAsset(leg.asset), TokenNotAccepted(leg.asset));

        // Check 6.
        Params memory p = leg.params;
        (p.toleranceBps, p.lossCapBps, p.bandBps, p.assetCooldown, p.sessionOpen, p.sessionClose) = cfg.params();
        uint256 until = uint256($.lastKeeperAt[leg.asset]) + p.assetCooldown;
        require(block.timestamp >= until, Cooldown(leg.asset, uint64(until)));

        // Checks 9 and 10, on the asset traded.
        leg.config = cfg.asset(leg.asset);
        _checkToken(leg.asset, leg.config);
        _checkMarket(cfg, leg.asset, leg.config, p);

        // Check 8, for the asset traded and for every other target the vault holds: the weights and the
        // loss cap are shares of the whole, so one target that cannot be valued stops the trade.
        _checkSequencer(cfg);
        uint16 devBps = cfg.priceDevBps();
        (leg.sessionOpenAt, leg.sessionAge) = _sessionRule(cfg, p);
        leg.price = _reference(leg.asset, leg.config, devBps, leg.sessionOpenAt, leg.sessionAge);
        leg.cashDecimals = cfg.asset(leg.cash).tokenDecimals;
        Weight[] memory list = $.targets;
        for (uint256 i; i < list.length; ++i) {
            address token = list[i].token;
            if (token == leg.asset) continue;
            uint256 amount = _held(token);
            require(amount != UNREADABLE, BalanceUnreadable(token));
            if (amount == 0) continue;
            // Watched by the trade's "no other token went down", whether or not it came in by a swap.
            $.tokens.add(token);
            AssetConfig memory a = cfg.asset(token);
            uint256 price = _reference(token, a, devBps, leg.sessionOpenAt, leg.sessionAge);
            leg.others += _value(amount, price, a, leg.cashDecimals);
        }

        uint256 assetHeld = _held(leg.asset);
        uint256 cashHeld = _held(leg.cash);
        require(assetHeld != UNREADABLE, BalanceUnreadable(leg.asset));
        require(cashHeld != UNREADABLE, BalanceUnreadable(leg.cash));
        leg.assetValue = _value(assetHeld, leg.price, leg.config, leg.cashDecimals);
        leg.vaultValue = _total(leg.others, leg.assetValue, cashHeld);

        // Check 5, before the trade.
        _towardTarget(leg.buying, leg.assetValue, leg.vaultValue, leg.targetBps, leg.asset);
    }

    /// Checks 4, 5 and 7 on what the trade did, then writes the cooldown and the loss counter.
    function _afterLeg(VaultStorage storage $, Leg memory leg, Swap calldata s, uint256 spent, uint256 received)
        private
    {
        uint256 assetValue = _value(_held(leg.asset), leg.price, leg.config, leg.cashDecimals);
        uint256 vaultValue = _total(leg.others, assetValue, _held(leg.cash));

        // Check 4: what came in against what went out, at the reference price, cash at $1.
        (uint256 spentValue, uint256 receivedValue) = leg.buying
            ? (spent, _value(received, leg.price, leg.config, leg.cashDecimals))
            : (_value(spent, leg.price, leg.config, leg.cashDecimals), received);
        require(
            receivedValue * BPS >= spentValue * (BPS - leg.params.toleranceBps), ValueTooLow(spentValue, receivedValue)
        );

        // Check 5: where the asset sits after the trade.
        _insideBand(leg.buying, assetValue, vaultValue, leg.targetBps, leg.params.bandBps, leg.asset);
        _noFurther(leg.assetValue, leg.vaultValue, assetValue, vaultValue, leg.targetBps, leg.asset);

        // Check 7: what the trade lost is added to what is left of the week's losses. A trade that lost
        // nothing is not held to the cap and does not touch the counter.
        uint256 loss = spentValue > receivedValue ? spentValue - receivedValue : 0;
        uint256 used = _lossLeft($) + loss;
        if (loss != 0) {
            require(
                used * BPS <= leg.vaultValue * leg.params.lossCapBps,
                LossCapReached(used, leg.vaultValue * leg.params.lossCapBps / BPS)
            );
            $.lossAccum = used;
            $.lossTs = uint64(block.timestamp);
        }
        $.lastKeeperAt[leg.asset] = uint64(block.timestamp);

        uint256 usedBps = leg.vaultValue == 0 ? 0 : Math.min(used * BPS / leg.vaultValue, type(uint16).max);
        emit KeeperTrade(address(this), s.tokenIn, s.tokenOut, spent, received, loss, uint16(usedBps));
    }

    /// Check 5, before the trade. A weight is the asset's value over everything the vault holds, cash
    /// included. A purchase needs the asset under its target and a sale needs it over.
    function _towardTarget(bool buying, uint256 assetValue, uint256 vaultValue, uint16 targetBps, address token)
        private
        pure
    {
        uint256 weight = assetValue * BPS;
        uint256 target = vaultValue * targetBps;
        require(buying ? weight < target : weight > target, NotTowardTarget(token));
    }

    /// Check 5, after the trade, the first half. The asset may sit anywhere inside the band, on either side
    /// of its target; outside the band on the far side is past it.
    function _insideBand(
        bool buying,
        uint256 assetValue,
        uint256 vaultValue,
        uint16 targetBps,
        uint16 bandBps,
        address token
    ) private pure {
        uint256 edge = buying ? uint256(targetBps) + bandBps : (targetBps > bandBps ? targetBps - bandBps : 0);
        uint256 weight = assetValue * BPS;
        uint256 limit = vaultValue * edge;
        require(buying ? weight <= limit : weight >= limit, PastTarget(token));
    }

    /// Check 5, after the trade, the second half. The asset ends no further from its target than it began,
    /// and a trade that crosses the target ends at most half as far on the other side. Inside the band
    /// alone, a stolen key could carry an asset from one edge to the other and back each cooldown, paying the
    /// tolerance each way; with "no further" alone it could still flip an asset that had drifted to exactly
    /// as far on the other side. Half as far makes each crossing close the distance.
    ///
    /// `|a1/V1 - t| <= |a0/V0 - t|` is compared as `|a1*10^4 - t*V1| * V0 <= |a0*10^4 - t*V0| * V1`, so
    /// nothing is divided; a trade that crossed has its left side doubled.
    function _noFurther(
        uint256 assetBefore,
        uint256 vaultBefore,
        uint256 assetAfter,
        uint256 vaultAfter,
        uint16 targetBps,
        address token
    ) private pure {
        uint256 weightBefore = assetBefore * BPS;
        uint256 targetBefore = vaultBefore * targetBps;
        uint256 weightAfter = assetAfter * BPS;
        uint256 targetAfter = vaultAfter * targetBps;
        uint256 offBefore = weightBefore > targetBefore ? weightBefore - targetBefore : targetBefore - weightBefore;
        uint256 offAfter = weightAfter > targetAfter ? weightAfter - targetAfter : targetAfter - weightAfter;
        // Under its target before and over it after, or over it before and under it after.
        bool crossed = (weightBefore < targetBefore && weightAfter > targetAfter)
            || (weightBefore > targetBefore && weightAfter < targetAfter);
        uint256 factor = crossed ? 2 : 1;
        require(offAfter * vaultBefore * factor <= offBefore * vaultAfter, PastTarget(token));
    }

    /// Check 10, and the issuer's own switch: not within a day of a change of the token's multiplier,
    /// before or after, by the token's own schedule; not paused by its issuer; not halted by the guardian.
    /// A schedule or a pause probe that does not answer refuses the trade.
    function _checkToken(address token, AssetConfig memory a) private view {
        if (a.scheduleSelector != bytes4(0)) {
            (bool ok, uint256 effectiveAt) = _readWord(token, a.scheduleSelector);
            uint256 apart =
                effectiveAt > block.timestamp ? effectiveAt - block.timestamp : block.timestamp - effectiveAt;
            require(ok && apart >= MULTIPLIER_WINDOW, MultiplierWindow(token, effectiveAt));
        }
        if (a.pauseProbe != address(0) && a.pauseSelector != bytes4(0)) {
            (bool ok, uint256 paused) = _readWord(a.pauseProbe, a.pauseSelector);
            require(ok && paused == 0, AssetPaused(token));
        }
        require(block.timestamp >= a.haltUntil, AssetHalted(token, a.haltUntil));
    }

    /// Check 9, for a US stock (`session` 1): Monday to Friday, UTC, from the session's open up to but not
    /// at its close, not on a closed day, and not before `closedUntil`. An asset that trades at all hours is
    /// always open. The same rule as the Solana program's `market_open`.
    function _checkMarket(IVaultConfig cfg, address token, AssetConfig memory a, Params memory p) private view {
        if (a.session == 0) return;
        (bool inSession, uint256 day) = _inSession(p);
        bool open = inSession && !cfg.closedDay(uint32(day)) && block.timestamp >= cfg.closedUntil();
        require(open, MarketClosed(token));
    }

    /// Whether the clock is inside the session, Monday to Friday, and the day it is, in days since 1970.
    function _inSession(Params memory p) private view returns (bool inSession, uint256 day) {
        day = block.timestamp / 1 days;
        uint256 second = block.timestamp % 1 days;
        // Day 0 was a Thursday; 0 is Sunday.
        uint256 weekday = (day + 4) % 7;
        inSession = weekday >= 1 && weekday <= 5 && second >= p.sessionOpen && second < p.sessionClose;
    }

    /// On a chain with a sequencer feed (Base), the sequencer is up and has been for an hour. Robinhood
    /// Chain has none.
    function _checkSequencer(IVaultConfig cfg) private view {
        address feed = cfg.sequencerFeed();
        if (feed == address(0)) return;
        (bool ok, bytes memory ret) = feed.staticcall(abi.encodeWithSelector(LATEST_ROUND_DATA));
        bool up;
        if (ok && ret.length >= 160) {
            (, int256 answer, uint256 startedAt,,) = abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
            up = answer == 0 && startedAt <= block.timestamp && block.timestamp - startedAt >= SEQUENCER_GRACE;
        }
        require(up, SequencerDown());
    }

    /// The price the keeper may value `token` at, in its feed's units, or the reason it may not. In the
    /// Solana program's order: a feed, the admin's switch, a price, the asset's range, the price's age, the
    /// average's age, and the distance between the two.
    ///
    /// The range is what bounds a wrong price that is steady and followed by its own average: the switch and
    /// the range are the admin's, set only after the feed is seen to move with the market.
    ///
    /// For a US stock while the session is open, and where the config sets `sessionPriceAge`, the price must
    /// also be today's: stamped at or after the session's open and no older than that age. Without it
    /// yesterday's close, 18.5 hours old at the open, is "fresh" under a 26-hour `maxAge` until the feed's
    /// first round of the day.
    function _reference(address token, AssetConfig memory a, uint16 devBps, uint256 sessionOpenAt, uint32 sessionAge)
        private
        view
        returns (uint256 price)
    {
        require(a.source == 1 && a.feed != address(0), AssetNotPriced(token));
        require(a.flags & KEEPER_ON != 0, KeeperAssetOff(token));
        uint256 updatedAt;
        (price, updatedAt) = _readFeed(a.feed);
        require(price != 0, AssetNotPriced(token));
        require(price >= a.minPrice && price <= a.maxPrice, PriceOutOfRange(token, price));
        require(_fresh(updatedAt, a.maxAge), PriceStale(token, updatedAt));
        if (a.session == 1 && sessionOpenAt != 0) {
            require(updatedAt >= sessionOpenAt && _fresh(updatedAt, sessionAge), PriceStale(token, updatedAt));
        }
        (uint256 average, uint256 averageAt) = _readFeed(a.averageFeed);
        require(average != 0, AssetNotPriced(token));
        require(_fresh(averageAt, a.maxAge), PriceStale(token, averageAt));
        uint256 apart = price > average ? price - average : average - price;
        require(average <= type(uint128).max && apart * BPS <= average * devBps, PriceDeviation(token, price, average));
    }

    /// When today's session opened and the in-session age the config sets, or zeros when the config sets no
    /// such age or the clock is outside Monday to Friday, open to close. Closed days are not read here: on
    /// one, a stock cannot be traded at all (check 9), and one that is only held is then held to a price of
    /// that day, which errs toward refusing.
    function _sessionRule(IVaultConfig cfg, Params memory p) private view returns (uint256 openAt, uint32 age) {
        age = cfg.sessionPriceAge();
        if (age == 0) return (0, 0);
        (bool inSession, uint256 day) = _inSession(p);
        if (!inSession) return (0, 0);
        openAt = day * 1 days + p.sessionOpen;
    }

    /// A price stamped at most `maxAge` ago, and not further ahead of the clock than that.
    function _fresh(uint256 stamp, uint32 maxAge) private view returns (bool) {
        return stamp <= block.timestamp ? block.timestamp - stamp <= maxAge : stamp - block.timestamp <= maxAge;
    }

    /// A Chainlink-style feed's answer and its time, or a zero answer for a feed that does not answer as one
    /// or answers zero or below.
    function _readFeed(address feed) private view returns (uint256 answer, uint256 updatedAt) {
        (bool ok, bytes memory ret) = feed.staticcall(abi.encodeWithSelector(LATEST_ROUND_DATA));
        if (!ok || ret.length < 160) return (0, 0);
        (, int256 signed,, uint256 stamp,) = abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
        return signed > 0 ? (uint256(signed), stamp) : (0, 0);
    }

    /// One word from a view of `target` that takes no argument, without trusting it: at most 32 bytes are
    /// copied, and a revert or a short answer is `ok == false` with a word of zero.
    function _readWord(address target, bytes4 selector) private view returns (bool ok, uint256 word) {
        assembly ("memory-safe") {
            mstore(0x00, selector)
            ok := staticcall(SWEEP_BALANCE_GAS, target, 0x00, 0x04, 0x00, 0x20)
            ok := and(ok, iszero(lt(returndatasize(), 0x20)))
            word := mul(mload(0x00), ok)
        }
    }

    /// What `amount` of an asset is worth at `price`, in raw units of the cash token, rounded down.
    function _value(uint256 amount, uint256 price, AssetConfig memory a, uint8 cashDecimals)
        private
        pure
        returns (uint256 value)
    {
        value = Math.mulDiv(amount, price * 10 ** cashDecimals, 10 ** (uint256(a.feedDecimals) + a.tokenDecimals));
        require(value <= MAX_VALUE, ValueTooLarge(value));
    }

    /// What the vault is worth: its other targets, the asset traded, and its cash at $1.
    function _total(uint256 others, uint256 asset, uint256 cash) private pure returns (uint256 total) {
        require(cash <= MAX_VALUE, ValueTooLarge(cash));
        total = others + asset + cash;
        require(total <= MAX_VALUE, ValueTooLarge(total));
    }

    /// What is left of the loss counter now.
    function _lossLeft(VaultStorage storage $) private view returns (uint256) {
        uint256 elapsed = block.timestamp - $.lossTs;
        if (elapsed >= LOSS_WINDOW) return 0;
        return $.lossAccum * (LOSS_WINDOW - elapsed) / LOSS_WINDOW;
    }

    /// Lets the router take exactly `amount` of `token`, the way the config says it pulls.
    function _approve(address token, address router, uint8 pull, uint256 amount) private {
        if (pull == PULL_PERMIT2) {
            IERC20(token).forceApprove(PERMIT2, amount);
            // Good for this block only.
            IPermit2(PERMIT2).approve(token, router, SafeCast.toUint160(amount), uint48(block.timestamp));
        } else {
            IERC20(token).forceApprove(router, amount);
        }
    }

    /// Takes back whatever the router did not use, and reads that nothing is left (I3). The reads are the
    /// check: a token or a Permit2 that ignores the reset fails the swap.
    function _revoke(address token, address router, uint8 pull) private {
        address spender = router;
        if (pull == PULL_PERMIT2) {
            IPermit2(PERMIT2).approve(token, router, 0, 0);
            (uint160 inPermit2,,) = IPermit2(PERMIT2).allowance(address(this), token, router);
            require(inPermit2 == 0, IBasketVault.AllowanceLeft(token, router, inPermit2));
            spender = PERMIT2;
        }
        IERC20(token).forceApprove(spender, 0);
        uint256 onToken = IERC20(token).allowance(address(this), spender);
        require(onToken == 0, IBasketVault.AllowanceLeft(token, spender, onToken));
    }

    /// The vault's balance of `token`, or `UNREADABLE`.
    function _held(address token) private view returns (uint256) {
        (bool ok, uint256 amount) = _tryBalanceOf(token);
        return ok ? amount : UNREADABLE;
    }

    /// Reads this vault's balance without trusting the token: a revert, an address with no code, a short
    /// answer or one that needs more than `SWEEP_BALANCE_GAS` gives `false`. At most 32 bytes are copied.
    function _tryBalanceOf(address token) private view returns (bool ok, uint256 held) {
        bytes4 selector = IERC20.balanceOf.selector;
        assembly ("memory-safe") {
            mstore(0x00, selector)
            mstore(0x04, address())
            ok := staticcall(SWEEP_BALANCE_GAS, token, 0x00, 0x24, 0x00, 0x20)
            ok := and(ok, gt(returndatasize(), 0x1f))
            held := mload(0x00)
        }
    }

    /// Transfers with at most `SWEEP_TRANSFER_GAS`, without trusting the token. `true` only if the call
    /// succeeded and the token answered `true` or answered nothing (USDT-style): the rule of OpenZeppelin's
    /// `trySafeTransfer`, which cannot be used here because it passes on all the gas. That one also checks
    /// the token has code; here `_tryBalanceOf` has just had a full word back from it, so it has.
    function _tryTransfer(address token, address to, uint256 amount) private returns (bool ok) {
        bytes4 selector = IERC20.transfer.selector;
        assembly ("memory-safe") {
            let fmp := mload(0x40)
            mstore(0x00, selector)
            mstore(0x04, to)
            mstore(0x24, amount)
            ok := call(SWEEP_TRANSFER_GAS, token, 0, 0x00, 0x44, 0x00, 0x20)
            let size := returndatasize()
            let saidTrue := and(gt(size, 0x1f), eq(mload(0x00), 1))
            ok := and(ok, or(saidTrue, iszero(size)))
            mstore(0x40, fmp)
        }
    }

    function _vault() internal pure returns (VaultStorage storage $) {
        assembly {
            $.slot := VAULT_STORAGE
        }
    }
}
