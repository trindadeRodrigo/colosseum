// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {VaultConfig} from "../../src/VaultConfig.sol";

/// The smallest contract that carries `VaultConfig`, for tests. The factory of EVM-2 takes its place.
contract ConfigHarness is VaultConfig {
    constructor(address admin_) initializer {
        _initVaultConfig(admin_);
    }

    /// Stands in for the guardian's `haltAsset` of EVM-3: writes the halt and nothing else.
    function haltForTest(address token, uint64 until) external {
        _config().assets[token].haltUntil = until;
    }
}
