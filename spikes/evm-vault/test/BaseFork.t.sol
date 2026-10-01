// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "../src/BasketVault.sol";

/// Documents the failure: B20 tokens are precompiles (code = 0xef), so a Foundry fork cannot run them.
///   BASE_RPC_URL=https://mainnet.base.org forge test --match-contract BaseFork -vv
contract BaseForkTest is Test {
    address constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address constant AERO_POOL = 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;

    function test_b20_does_not_execute_in_fork() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
        assertEq(NVDAC.code, hex"ef");
        (bool ok,) = NVDAC.staticcall(abi.encodeCall(IERC20.balanceOf, (AERO_POOL)));
        assertFalse(ok, "if this fails, Foundry learned to run B20 precompiles: switch Base to real fork tests");
    }
}
