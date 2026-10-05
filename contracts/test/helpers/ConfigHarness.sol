// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Params} from "../../src/interfaces/Types.sol";
import {VaultConfig} from "../../src/VaultConfig.sol";

/// The smallest contract that carries `VaultConfig`, for the tests of the settings alone. The factory is
/// what carries it in production, and what every vault test uses.
contract ConfigHarness is VaultConfig {
    constructor(address admin_, Params memory params_) initializer {
        _initVaultConfig(admin_, params_);
    }
}
