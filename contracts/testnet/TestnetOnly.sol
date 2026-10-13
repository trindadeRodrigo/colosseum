// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

/// TEST NETWORK ONLY. The base of every contract in this folder. Its constructor refuses the chain ids of
/// the mainnets the vault is built for, so none of them can be created there: a price one key writes, a
/// token one key mints or an exchange one key re-centres has no place beside real money.
///
/// It stops a mistake, not a person: someone who edits this file can still deploy what they like. The
/// deploy script holds a mainnet file's feeds to Chainlink's own, which is the second check.
abstract contract TestnetOnly {
    error MainnetRefused(uint256 chainId);

    constructor() {
        // Ethereum, Robinhood Chain, Base.
        require(block.chainid != 1 && block.chainid != 4663 && block.chainid != 8453, MainnetRefused(block.chainid));
    }
}
