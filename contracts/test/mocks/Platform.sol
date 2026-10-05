// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {AssetConfig} from "../../src/interfaces/Types.sol";

/// The part of the factory the registry reads, with nothing checked: an asset list whose ceilings can be
/// anything, a cash token, the three roles and the launch switch. The real config holds a ceiling to 5,000;
/// this one does not, so the registry's own cap can be seen at work.
contract MockPlatform {
    mapping(address token => bool) public isAsset;
    mapping(address token => uint16) public ceiling;
    address public cashToken;
    address public admin;
    address public guardian;
    bool public launched;

    constructor(address admin_, address guardian_) {
        admin = admin_;
        guardian = guardian_;
    }

    function list(address token, uint16 maxWeightBps) external {
        isAsset[token] = true;
        ceiling[token] = maxWeightBps;
    }

    function setCashToken(address token) external {
        cashToken = token;
    }

    function setLaunched(bool on) external {
        launched = on;
    }

    function asset(address token) external view returns (AssetConfig memory cfg) {
        cfg.maxWeightBps = ceiling[token];
    }
}
