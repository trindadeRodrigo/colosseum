// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IVaultConfig} from "./interfaces/IVaultConfig.sol";
import {AssetConfig} from "./interfaces/Types.sol";

/// The platform's settings for one chain, and the admin who may change them: the cash token, the listed
/// assets with their price feeds, and the allowed routers. A vault is given this contract's address when it
/// is created and reads from it; nothing here is a constant in the vault.
///
/// Two lists that must never overlap: a listed asset is never an allowed router, and a router is never a
/// listed asset. With a token as the "router", swap data could be an `approve`, which moves no balance.
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
        address cashToken;
    }

    // keccak256(abi.encode(uint256(keccak256("basket.storage.VaultConfig")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant CONFIG_STORAGE = 0xfd793af9d792c20ec648aa0fa0966554130cc76dee781a8faf62dee5e65f8b00;

    /// How a router pulls its input: 1 direct, 2 through Permit2. Anything above is not a known way.
    uint8 internal constant MAX_PULL = 2;
    /// `source`: 0 none, 1 Chainlink. `session`: 0 always, 1 US stocks.
    uint8 internal constant MAX_SOURCE = 1;
    uint8 internal constant MAX_SESSION = 1;
    /// Price maths scales by `10 ** decimals`; 18 is the most a listed token or a feed has.
    uint8 internal constant MAX_DECIMALS = 18;
    /// No asset may be more than half of a shared portfolio (section 6).
    uint16 internal constant MAX_ASSET_WEIGHT_BPS = 5000;
    /// How old a price may be set to count as fresh. The design uses 26 hours for stocks; a minute is
    /// shorter than any feed updates, and past two days a Friday close would pass for a Monday price.
    uint32 internal constant MIN_PRICE_AGE = 60;
    uint32 internal constant MAX_PRICE_AGE = 48 hours;

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

    /// Lists an asset or replaces its settings, the price feed included. The stored `haltUntil` is kept and
    /// the one passed in is ignored: a halt is the guardian's (EVM-3), and a feed update must not lift it.
    function setAsset(address token, AssetConfig calldata cfg) external onlyAdmin {
        require(token != address(0), ZeroAddress());
        require(token.code.length != 0, NoCode(token));
        ConfigStorage storage $ = _config();
        require($.routerPull[token] == 0, AssetIsRouter(token));
        require(cfg.source <= MAX_SOURCE, ParamOutOfBounds("source", cfg.source));
        require(cfg.session <= MAX_SESSION, ParamOutOfBounds("session", cfg.session));
        require(cfg.tokenDecimals <= MAX_DECIMALS, ParamOutOfBounds("tokenDecimals", cfg.tokenDecimals));
        require(cfg.feedDecimals <= MAX_DECIMALS, ParamOutOfBounds("feedDecimals", cfg.feedDecimals));
        require(cfg.maxWeightBps <= MAX_ASSET_WEIGHT_BPS, ParamOutOfBounds("maxWeightBps", cfg.maxWeightBps));
        require(cfg.source == 0 || cfg.feed != address(0), FeedRequired(token));
        if (cfg.feed != address(0)) {
            require(cfg.maxAge >= MIN_PRICE_AGE, ParamOutOfBounds("maxAge", cfg.maxAge));
            require(cfg.maxAge <= MAX_PRICE_AGE, ParamOutOfBounds("maxAge", cfg.maxAge));
        }

        uint64 halt = $.assets[token].haltUntil;
        $.assetList.add(token);
        $.assets[token] = cfg;
        $.assets[token].haltUntil = halt;
        emit AssetSet(token, $.assets[token]);
    }

    /// Allows a router (1 direct, 2 through Permit2) or removes it (0). Removing always works.
    function setRouter(address router, uint8 pull) external onlyAdmin {
        require(router != address(0), ZeroAddress());
        require(pull <= MAX_PULL, InvalidPull(pull));
        ConfigStorage storage $ = _config();
        if (pull != 0) {
            require(router.code.length != 0, NoCode(router));
            // Covers the cash token too: it is always a listed asset.
            require(!$.assetList.contains(router), RouterIsAsset(router));
        }
        $.routerPull[router] = pull;
        emit RouterSet(router, pull);
    }

    /// Names the chain's dollar token, the only token a vault takes as a deposit. It must be a listed asset,
    /// which also means it is not zero, has code and is not a router.
    function setCashToken(address token) external onlyAdmin {
        ConfigStorage storage $ = _config();
        require($.assetList.contains(token), AssetNotListed(token));
        $.cashToken = token;
        emit CashTokenSet(token);
    }

    /// Step one of a handover. Nothing changes until `next` accepts, so a mistyped address cannot take the
    /// role. Proposing the zero address takes a proposal back.
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
    function cashToken() public view returns (address) {
        return _config().cashToken;
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
