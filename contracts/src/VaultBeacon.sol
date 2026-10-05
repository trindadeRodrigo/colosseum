// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

/// The one beacon every vault of a chain reads its logic from. Its owner can replace that logic for all of
/// them in one transaction, so the key is handed over in two steps and cannot be given up: a mistyped
/// address would otherwise lose the upgrade key for every vault.
contract VaultBeacon is UpgradeableBeacon, Ownable2Step {
    error RenounceDisabled();

    constructor(address implementation_, address owner_) UpgradeableBeacon(implementation_, owner_) {}

    /// Step one. Nothing changes until `newOwner` calls `acceptOwnership`.
    function transferOwnership(address newOwner) public override(Ownable, Ownable2Step) {
        Ownable2Step.transferOwnership(newOwner);
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function _transferOwnership(address newOwner) internal override(Ownable, Ownable2Step) {
        Ownable2Step._transferOwnership(newOwner);
    }
}
