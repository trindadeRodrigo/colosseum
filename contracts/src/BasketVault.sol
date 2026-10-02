// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IBasketVault} from "./interfaces/IBasketVault.sol";
import {IVaultConfig} from "./interfaces/IVaultConfig.sol";

/// One person's vault for one plan on one chain. The logic contract behind every vault's beacon proxy.
///
/// This is the owner path only (EVM-1): deposit, and withdraw in kind to the owner. The swap, the keeper
/// path, targets, accept and adopt are later slots; their signatures are in `IBasketVault`, which this
/// contract inherits once it implements all of it.
///
/// Rules that hold here and must keep holding:
/// - Tokens leave only by the owner's call and only to the owner (I1). No function takes a recipient, the
///   destination is the stored owner and never the caller, and the owner is set once and cannot be changed.
/// - Withdrawing reads no feed and calls neither the config, the factory nor the registry (I4). Only a
///   beacon upgrade can block it.
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
        // Every token the owner has put in. `withdrawAll` walks this list and nothing else.
        EnumerableSet.AddressSet tokens;
    }

    // keccak256(abi.encode(uint256(keccak256("basket.storage.BasketVault")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant VAULT_STORAGE = 0xa3206dd01d46554bcca9bfac00567bdedfa0efb64d962bf4bf1458722c932700;

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

    /// Pulls `amount` of a listed token from the owner. The vault's balance must rise by at least `amount`:
    /// a token that skims a fee on transfer is refused, because every later check (a swap's minimum, the
    /// keeper's value check) assumes a transfer moves what it says.
    function deposit(address token, uint256 amount) external onlyOwner nonReentrant {
        VaultStorage storage $ = _vault();
        require($.config.isAsset(token), IBasketVault.AssetNotListed(token));
        $.tokens.add(token);

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        require(received >= amount, IBasketVault.DepositShortfall(token, amount, received));
    }

    /// Sends `amount` of any token the vault holds to the owner, listed or not. Fails if the token does.
    function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(_vault().owner, amount);
    }

    /// Sends the whole balance of every deposited token to the owner. A token that reverts or answers
    /// `false` is skipped and reported, so one frozen token cannot hold the others (A9).
    function withdrawAll() external onlyOwner nonReentrant returns (address[] memory skipped) {
        VaultStorage storage $ = _vault();
        address to = $.owner;
        address[] memory list = $.tokens.values();
        skipped = new address[](list.length);
        uint256 n;
        for (uint256 i; i < list.length; ++i) {
            (bool readable, uint256 held) = _tryBalanceOf(list[i]);
            if (readable && held == 0) continue;
            if (!readable || !IERC20(list[i]).trySafeTransfer(to, held)) skipped[n++] = list[i];
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

    /// The tokens `withdrawAll` walks, in the order they were first deposited.
    function tokens() external view returns (address[] memory) {
        return _vault().tokens.values();
    }

    // ---- internals

    /// Reads this vault's balance without trusting the token: a revert, an address with no code or a short
    /// answer gives `false`, and at most 32 bytes of the answer are copied.
    function _tryBalanceOf(address token) private view returns (bool ok, uint256 held) {
        bytes4 selector = IERC20.balanceOf.selector;
        assembly ("memory-safe") {
            mstore(0x00, selector)
            mstore(0x04, address())
            ok := staticcall(gas(), token, 0x00, 0x24, 0x00, 0x20)
            ok := and(ok, gt(returndatasize(), 0x1f))
            held := mload(0x00)
        }
    }

    function _vault() private pure returns (VaultStorage storage $) {
        assembly {
            $.slot := VAULT_STORAGE
        }
    }
}
