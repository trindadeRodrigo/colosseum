// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {IBasketVault} from "./interfaces/IBasketVault.sol";
import {IVaultFactory} from "./interfaces/IVaultFactory.sol";
import {Params, Swap, Weight} from "./interfaces/Types.sol";
import {VaultConfig} from "./VaultConfig.sol";

/// Creates the vaults of one chain and holds the platform's settings (`VaultConfig`). The logic contract
/// behind a UUPS proxy; only the admin can replace it.
///
/// What a vault's address is bound to: this factory, the beacon, the owner and the plan id. The owner is
/// the caller, always. So nobody can create the vault that `vaultOf(alice, plan)` names except Alice, and a
/// token sent to that address before the vault exists waits for her.
///
/// A vault is never left half made. The proxy's constructor runs `initialize`, which fixes the owner, and
/// the factory's next call, `start`, sets the targets and runs the first deposit and swaps. `start` works
/// only in that same transaction; after it the factory has no way into the vault.
///
/// Vaults are listed here so the app and the keeper find them with no event: `vaultAt`, `vaultsOf`,
/// `isVault`. An address that runs the same code and is not listed is not one of ours.
contract VaultFactory is VaultConfig, UUPSUpgradeable, IVaultFactory {
    /// @custom:storage-location erc7201:basket.storage.VaultFactory
    struct FactoryStorage {
        address beacon;
        address[] vaults;
        mapping(address vault => bool) isVault;
        mapping(address owner => address[]) byOwner;
        mapping(address owner => mapping(bytes32 salt => address)) bySalt;
    }

    // keccak256(abi.encode(uint256(keccak256("basket.storage.VaultFactory")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant FACTORY_STORAGE = 0x8fec4a6f33ee43a594c75e33fac51100fd8bfe1f4fe2c386cf1ea0b4e1504300;

    /// The logic contract itself can never be initialised; only its proxy can, once.
    constructor() {
        _disableInitializers();
    }

    /// Runs inside the proxy's constructor.
    /// @param admin_ May change every setting and replace this logic. Handed over in two steps.
    /// @param beacon_ The beacon every vault is created on. Fixed: there is no setter.
    /// @param params_ The keeper's limits, inside the bounds of `setParams`.
    function initialize(address admin_, address beacon_, Params calldata params_) external initializer {
        _initVaultConfig(admin_, params_);
        require(beacon_ != address(0), ZeroAddress());
        require(beacon_.code.length != 0, NoCode(beacon_));
        _factory().beacon = beacon_;
    }

    // ---- anyone, for themselves

    /// @inheritdoc IVaultFactory
    function createVault(
        bytes32 salt,
        Weight[] calldata targets,
        bytes32 indexId,
        uint32 expectedVersion,
        bool autoFollow
    ) external returns (address vault) {
        vault = _deploy(salt, autoFollow);
        IBasketVault(vault).start(indexId, expectedVersion, targets, 0, new Swap[](0));
    }

    /// @inheritdoc IVaultFactory
    function createVaultAndBuy(
        bytes32 salt,
        Weight[] calldata targets,
        bytes32 indexId,
        uint32 expectedVersion,
        bool autoFollow,
        uint256 cashAmount,
        Swap[] calldata swaps
    ) external returns (address vault) {
        vault = _deploy(salt, autoFollow);
        IBasketVault(vault).start(indexId, expectedVersion, targets, cashAmount, swaps);
    }

    // ---- views

    /// @inheritdoc IVaultFactory
    function vaultOf(address owner, bytes32 salt) public view returns (address) {
        FactoryStorage storage $ = _factory();
        address made = $.bySalt[owner][salt];
        if (made != address(0)) return made;
        return Create2.computeAddress(_salt(owner, salt), keccak256(_creationCode($.beacon, owner, salt)));
    }

    /// @inheritdoc IVaultFactory
    function isVault(address vault) public view returns (bool) {
        return _factory().isVault[vault];
    }

    function vaultCount() external view returns (uint256) {
        return _factory().vaults.length;
    }

    function vaultAt(uint256 i) external view returns (address) {
        return _factory().vaults[i];
    }

    function vaultsOf(address owner) external view returns (address[] memory) {
        return _factory().byOwner[owner];
    }

    function vaultCountOf(address owner) external view returns (uint256) {
        return _factory().byOwner[owner].length;
    }

    function vaultOfAt(address owner, uint256 i) external view returns (address) {
        return _factory().byOwner[owner][i];
    }

    /// @inheritdoc IVaultFactory
    function beacon() external view returns (address) {
        return _factory().beacon;
    }

    // ---- internals

    /// Creates the caller's vault for `salt` and lists it. The owner is `msg.sender` and nothing else: no
    /// argument names one.
    function _deploy(bytes32 salt, bool autoFollow) private returns (address vault) {
        require(!autoFollow, AutoFollowUnavailable());
        FactoryStorage storage $ = _factory();
        address owner = msg.sender;
        require($.bySalt[owner][salt] == address(0), VaultExists($.bySalt[owner][salt]));

        vault = Create2.deploy(0, _salt(owner, salt), _creationCode($.beacon, owner, salt));
        $.bySalt[owner][salt] = vault;
        $.isVault[vault] = true;
        $.vaults.push(vault);
        $.byOwner[owner].push(vault);
        emit VaultCreated(vault, owner, salt);
    }

    /// The proxy's creation code with its init call inside: the owner and the plan id are part of the code
    /// the address is derived from, and of the salt.
    function _creationCode(address beacon_, address owner, bytes32 salt) private pure returns (bytes memory) {
        bytes memory init = abi.encodeCall(IBasketVault.initialize, (owner, salt));
        return abi.encodePacked(type(BeaconProxy).creationCode, abi.encode(beacon_, init));
    }

    function _salt(address owner, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }

    /// The beacon and every vault are part of the platform, so never a router.
    function _isReserved(address target) internal view override returns (bool) {
        FactoryStorage storage $ = _factory();
        return super._isReserved(target) || target == $.beacon || $.isVault[target];
    }

    /// The beacon's owner can replace the code of every vault. At launch that key is the admin and nobody
    /// is waiting to take it over.
    function _checkLaunch() internal view override {
        Ownable2Step beacon_ = Ownable2Step(_factory().beacon);
        address beaconOwner = beacon_.owner();
        address pending = beacon_.pendingOwner();
        require(beaconOwner == admin() && pending == address(0), BeaconNotTheAdmins(beaconOwner, pending));
    }

    /// Replacing this logic is the admin's.
    function _authorizeUpgrade(address) internal view override {
        _checkAdmin();
    }

    function _factory() private pure returns (FactoryStorage storage $) {
        assembly {
            $.slot := FACTORY_STORAGE
        }
    }
}
