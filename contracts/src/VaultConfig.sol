// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IVaultConfig} from "./interfaces/IVaultConfig.sol";
import {AssetConfig} from "./interfaces/Types.sol";

/// Stub: the signatures only, so the tests compile and fail. The code follows in the next commit.
abstract contract VaultConfig is Initializable, IVaultConfig {
    function _initVaultConfig(address admin_) internal onlyInitializing {}

    function setAsset(address token, AssetConfig calldata cfg) external {}

    function setRouter(address router, uint8 pull) external {}

    function proposeAdmin(address next) external {}

    function acceptAdmin() external {}

    function admin() external view returns (address) {}

    function pendingAdmin() external view returns (address) {}

    function asset(address token) external view returns (AssetConfig memory) {}

    function assets() external view returns (address[] memory) {}

    function isAsset(address token) external view returns (bool) {}

    function routerPull(address router) external view returns (uint8) {}
}
