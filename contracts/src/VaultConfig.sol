// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IVaultConfig} from "./interfaces/IVaultConfig.sol";
import {AssetConfig} from "./interfaces/Types.sol";

/// The platform's settings for one chain, and the admin who may change them: the listed assets with their
/// price feeds, and the allowed routers. A vault is given this contract's address when it is created and
/// reads from it; nothing here is a constant in the vault.
///
/// Abstract on purpose: the factory of EVM-2 inherits it, adds creation, the keeper, the guardian and the
/// parameters, and is the contract behind the UUPS proxy. State lives in one ERC-7201 namespace, so the
/// factory adds its own namespace beside it and neither moves the other.
abstract contract VaultConfig is Initializable, IVaultConfig {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @custom:storage-location erc7201:basket.storage.VaultConfig
    struct ConfigStorage {
        address admin;
        address pendingAdmin;
        EnumerableSet.AddressSet assetList;
        mapping(address token => AssetConfig) assets;
        mapping(address router => uint8) routerPull;
    }

    // keccak256(abi.encode(uint256(keccak256("basket.storage.VaultConfig")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant CONFIG_STORAGE = 0xfd793af9d792c20ec648aa0fa0966554130cc76dee781a8faf62dee5e65f8b00;

    /// How a router pulls its input: 1 direct, 2 through Permit2. Anything above is not a known way.
    uint8 internal constant MAX_PULL = 2;

    modifier onlyAdmin() {
        _checkAdmin();
        _;
    }

    function _initVaultConfig(address admin_) internal onlyInitializing {
        require(admin_ != address(0), ZeroAddress());
        _config().admin = admin_;
        emit AdminChanged(address(0), admin_);
    }

    // ---- admin

    /// Lists an asset or replaces its settings, the price feed included.
    function setAsset(address token, AssetConfig calldata cfg) external onlyAdmin {
        require(token != address(0), ZeroAddress());
        require(cfg.source == 0 || cfg.feed != address(0), FeedRequired(token));
        ConfigStorage storage $ = _config();
        $.assetList.add(token);
        $.assets[token] = cfg;
        emit AssetSet(token, cfg);
    }

    /// Allows a router (1 direct, 2 through Permit2) or removes it (0).
    function setRouter(address router, uint8 pull) external onlyAdmin {
        require(router != address(0), ZeroAddress());
        require(pull <= MAX_PULL, InvalidPull(pull));
        _config().routerPull[router] = pull;
        emit RouterSet(router, pull);
    }

    /// Step one of a handover. Nothing changes until `next` accepts, so a mistyped address cannot take the role.
    function proposeAdmin(address next) external onlyAdmin {
        _config().pendingAdmin = next;
        emit AdminProposed(next);
    }

    function acceptAdmin() external {
        ConfigStorage storage $ = _config();
        require(msg.sender == $.pendingAdmin, NotPendingAdmin(msg.sender));
        emit AdminChanged($.admin, msg.sender);
        $.admin = msg.sender;
        $.pendingAdmin = address(0);
    }

    // ---- views

    function admin() public view returns (address) {
        return _config().admin;
    }

    function pendingAdmin() public view returns (address) {
        return _config().pendingAdmin;
    }

    /// @inheritdoc IVaultConfig
    function asset(address token) public view returns (AssetConfig memory) {
        return _config().assets[token];
    }

    /// @inheritdoc IVaultConfig
    function assets() public view returns (address[] memory) {
        return _config().assetList.values();
    }

    /// @inheritdoc IVaultConfig
    function isAsset(address token) public view returns (bool) {
        return _config().assetList.contains(token);
    }

    /// @inheritdoc IVaultConfig
    function routerPull(address router) public view returns (uint8) {
        return _config().routerPull[router];
    }

    // ---- internals

    function _checkAdmin() internal view {
        require(msg.sender == _config().admin, NotAdmin(msg.sender));
    }

    /// For the factory that inherits this: append fields to `ConfigStorage`, never reorder them.
    function _config() internal pure returns (ConfigStorage storage $) {
        assembly {
            $.slot := CONFIG_STORAGE
        }
    }
}
