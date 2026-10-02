// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {VaultConfig} from "../../src/VaultConfig.sol";

/// The smallest contract that carries `VaultConfig`, for tests. The factory of EVM-2 takes its place.
contract ConfigHarness is VaultConfig {
    constructor(address admin_) initializer {
        _initVaultConfig(admin_);
    }
}
