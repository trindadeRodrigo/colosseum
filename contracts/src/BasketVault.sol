// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IBasketVault} from "./interfaces/IBasketVault.sol";
import {IVaultConfig} from "./interfaces/IVaultConfig.sol";

/// One person's vault for one plan on one chain. The logic contract behind every vault's beacon proxy.
///
/// This is the owner path only (EVM-1): deposit the cash token, and withdraw in kind to the owner. The swap,
/// the keeper path, targets, accept and adopt are later slots; their signatures are in `IBasketVault`, which
/// this contract inherits once it implements all of it.
///
/// Rules that hold here and must keep holding:
/// - Money comes in as the chain's cash token only (gate `DEPOSIT`). The vault reads which token that is
///   from its config on every deposit. A token sent in from outside cannot be stopped: it is not in
///   `tokens`, and the owner takes it out with `withdraw`.
/// - Tokens leave only by the owner's call and only to the owner (I1). No function takes a recipient, the
///   destination is the stored owner and never the caller, and the owner is set once and cannot be changed.
///   There is no `fallback` and no `receive`.
/// - Withdrawing reads no feed and calls neither the config, the factory nor the registry (I4). Only a
///   beacon upgrade can block it.
/// - `withdrawAll` never leaves a token behind for lack of gas: short of gas it fails as a whole.
/// - Amounts are raw token units. The vault never calls `decimals()`; the config states them.
/// - State lives in one ERC-7201 namespace. Later slots append to `VaultStorage`, never reorder it, and
///   inherit only bases that are stateless or namespaced.
contract BasketVault is Initializable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @custom:storage-location erc7201:basket.storage.BasketVault
    struct VaultStorage {
        address owner;
        IVaultConfig config;
        bytes32 planId;
        // Every token that came in by a vault function: the cash token here, a swap's output from EVM-2 on.
        // `withdrawAll` walks this list and nothing else.
        EnumerableSet.AddressSet tokens;
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

    modifier onlyOwner() {
        require(msg.sender == _vault().owner, IBasketVault.NotOwner(msg.sender));
        _;
    }

    /// The logic contract itself can never be initialised; only a proxy can, once.
    constructor() {
        _disableInitializers();
    }

    /// Runs inside the proxy's constructor, so a vault never exists without an owner.
    /// @param owner_ The person. Fixed for the life of the vault.
    /// @param planId_ The plan this vault holds: the salt the factory derives the vault's address from.
    /// @param config_ Where the listed assets, their price feeds and the allowed routers are read from.
    function initialize(address owner_, bytes32 planId_, address config_) external initializer {
        require(owner_ != address(0) && config_ != address(0), IBasketVault.ZeroAddress());
        VaultStorage storage $ = _vault();
        $.owner = owner_;
        $.planId = planId_;
        $.config = IVaultConfig(config_);
    }

    // ---- owner only

    /// Pulls `amount` of the chain's cash token from the owner, and no other token. The vault's balance must
    /// rise by at least `amount`: a token that skims a fee on transfer is refused, because every later check
    /// (a swap's minimum, the keeper's value check) assumes a transfer moves what it says.
    function deposit(uint256 amount) external onlyOwner nonReentrant {
        VaultStorage storage $ = _vault();
        address cash = $.config.cashToken();
        require(cash != address(0), IBasketVault.CashTokenNotSet());
        $.tokens.add(cash);

        uint256 before = IERC20(cash).balanceOf(address(this));
        IERC20(cash).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(cash).balanceOf(address(this)) - before;
        require(received >= amount, IBasketVault.DepositShortfall(cash, amount, received));
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

    // ---- internals

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
