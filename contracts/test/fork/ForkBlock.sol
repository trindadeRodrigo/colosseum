// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";

/// The block the tests on a fork of Robinhood Chain mainnet read.
///
/// `RH_FORK_BLOCK` names it; left out, it is `DEFAULT`, the block `packages/chain-evm/test/pool-quotes.ts`
/// read each listed token's pool at on 2026-10-12 (ROBINHOOD-MAINNET-SCOPE, the per-token table). A node
/// has to keep that block's state: `https://robinhood.drpc.org` does, the chain's own public node drops it
/// within minutes. If a node stops serving the default, set `RH_FORK_BLOCK` to a later block and the same
/// assertions run there: nothing a test checks depends on which block it is.
///
/// The rig first pinned 77,417,307 (2026-10-01). Public nodes stopped answering for it reliably ("Unknown
/// state"), and the every-token test needs each token's pool as it was measured, so the default moved.
library ForkBlock {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant DEFAULT = 86_735_800;

    function number() internal view returns (uint256) {
        return VM.envOr("RH_FORK_BLOCK", DEFAULT);
    }
}
