// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {TransientSlot} from "@openzeppelin/contracts/utils/TransientSlot.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {MulticallUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/MulticallUpgradeable.sol";
import {IBasketVault} from "./interfaces/IBasketVault.sol";
import {IIndexRegistry} from "./interfaces/IIndexRegistry.sol";
import {IPermit2} from "./interfaces/IPermit2.sol";
import {IVaultConfig, PERMIT2} from "./interfaces/IVaultConfig.sol";
import {Swap, Weight} from "./interfaces/Types.sol";

/// One person's vault for one plan on one chain. The logic contract behind every vault's beacon proxy.
///
/// This is the owner's path and creation (EVM-1, EVM-2): deposit the cash token, swap through an allowed
/// router, set targets, and withdraw in kind to the owner. The keeper path, accept, adopt and auto-follow
/// are EVM-3; their signatures are in `IBasketVault`, which this contract inherits once it implements all
/// of it.
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
///   beacon upgrade can block it.
/// - `withdrawAll` never leaves a token behind for lack of gas: short of gas it fails as a whole.
/// - One reentrancy guard covers every function that changes state. `multicall` is the one exception: it
///   only calls back into the vault, and each inner call takes the guard itself.
/// - Amounts are raw token units. The vault never calls `decimals()`; the config states them.
/// - State lives in one ERC-7201 namespace. Later slots append to `VaultStorage`, never reorder it, and
///   inherit only bases that are stateless or namespaced.
contract BasketVault is Initializable, ReentrancyGuardTransient, MulticallUpgradeable {
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
        // Reserved (section 3.8). Nothing here sets it.
        address operator;
        // Sorted by token. The owner's own, or a copy of the followed portfolio's accepted version.
        Weight[] targets;
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
    function ownerSwap(Swap[] calldata swaps) external onlyOwner nonReentrant {
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

    /// Sends `amount` of any token the vault holds to the owner, whether it was deposited or sent in from
    /// outside. Passes on all the gas it is given, and fails if the token does.
    function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(_vault().owner, amount);
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
        address[] memory list = $.tokens.values();
        skipped = new address[](list.length);
        uint256 n;
        for (uint256 i; i < list.length; ++i) {
            require(gasleft() >= SWEEP_RESERVE, IBasketVault.GasTooLow(gasleft(), SWEEP_RESERVE));
            (bool readable, uint256 held) = _tryBalanceOf(list[i]);
            if (readable && held == 0) continue;
            if (!readable || !_tryTransfer(list[i], to, held)) {
                skipped[n++] = list[i];
                emit IBasketVault.WithdrawSkipped(list[i]);
            }
        }
        assembly ("memory-safe") {
            mstore(skipped, n)
        }
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
    }

    /// Copies the active version of a shared portfolio as the vault's targets, if it is the version the
    /// person reviewed. A create signed against version N that lands after N+1 took effect fails here (A18).
    function _follow(VaultStorage storage $, bytes32 indexId, uint32 expectedVersion) private {
        address registry = $.config.registry();
        require(registry != address(0), IBasketVault.RegistryNotSet());
        (uint32 version, Weight[] memory components) = IIndexRegistry(registry).active(indexId);
        require(version != 0, IBasketVault.IndexNotFound(indexId));
        require(version == expectedVersion, IBasketVault.VersionMismatch(indexId, expectedVersion, version));

        delete $.targets;
        for (uint256 i; i < components.length; ++i) {
            $.targets.push(components[i]);
        }
        $.indexId = indexId;
        $.acceptedVersion = version;
        emit IBasketVault.Followed(address(this), indexId, version);
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
            // The config keeps these out of its router list. The vault does not take its word for it: with
            // a token it holds, Permit2 or itself as the router, `data` could be an approval.
            require(
                s.router != address(this) && s.router != PERMIT2 && !$.tokens.contains(s.router),
                IBasketVault.RouterNotAllowed(s.router)
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

    /// One swap. `held` is what the vault had of each token in `list` before it, and is updated to what it
    /// has after.
    function _swap(Swap calldata s, uint8 pull, address[] memory list, uint256[] memory held) private {
        _approve(s.tokenIn, s.router, pull, s.amountIn);
        (bool ok, bytes memory reason) = s.router.call(s.data);
        require(ok, IBasketVault.RouterFailed(s.router, reason));
        _revoke(s.tokenIn, s.router, pull);

        uint256 spent;
        uint256 received;
        for (uint256 j; j < list.length; ++j) {
            address token = list[j];
            uint256 was = held[j];
            uint256 left = _held(token);
            held[j] = left;
            if (token == s.tokenIn) {
                require(was != UNREADABLE && left != UNREADABLE, IBasketVault.BalanceUnreadable(token));
                spent = was > left ? was - left : 0;
                require(spent <= s.amountIn, IBasketVault.SpentTooMuch(token, spent, s.amountIn));
            } else if (token == s.tokenOut) {
                require(was != UNREADABLE && left != UNREADABLE, IBasketVault.BalanceUnreadable(token));
                received = left > was ? left - was : 0;
                require(received >= s.minOut, IBasketVault.ReceivedTooLittle(token, received, s.minOut));
            } else if (was != UNREADABLE) {
                // A token that could not be read before the swap (frozen by its issuer, say) is left out,
                // so that it cannot hold up trades in the others. One that could be read must still be
                // readable, and not lower.
                require(left != UNREADABLE && left >= was, IBasketVault.OtherTokenDebited(token, was, left));
            }
        }
        emit IBasketVault.OwnerTrade(address(this), s.tokenIn, s.tokenOut, spent, received);
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

    function _vault() private pure returns (VaultStorage storage $) {
        assembly {
            $.slot := VAULT_STORAGE
        }
    }
}
