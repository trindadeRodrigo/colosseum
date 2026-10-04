// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

/// The ABIs committed in `idl/evm/` are what the build gives. The adapter and the app read those files, so a
/// function, an event or an error changed here without them would not be seen until a call failed. After a
/// change to a contract's interface: `forge build && node script/abi.mjs`.
contract AbiTest is Test {
    function _assertCommitted(string memory name) internal view {
        string memory committed = vm.readFile(string.concat("../idl/evm/", name, ".json"));
        string memory artifact = vm.readFile(string.concat("out/", name, ".sol/", name, ".json"));
        bytes memory built = vm.parseJson(artifact, ".abi");
        assertGt(built.length, 64, "the build's ABI was not read");
        assertEq(
            keccak256(vm.parseJson(committed)),
            keccak256(built),
            string.concat("idl/evm/", name, ".json is not the build's: run node script/abi.mjs")
        );
    }

    function test_abi_committedFilesAreTheBuilds() public view {
        _assertCommitted("BasketVault");
        _assertCommitted("VaultFactory");
        _assertCommitted("VaultConfig");
        _assertCommitted("IndexRegistry");
        _assertCommitted("VaultBeacon");
    }
}
