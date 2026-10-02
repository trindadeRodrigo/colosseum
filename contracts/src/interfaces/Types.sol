// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

// The shared structs of DESIGN-VAULT.md section 3.8. Field order is part of the ABI: append, never reorder.

/// One asset of a portfolio and its weight. Lists are sorted by token, with no duplicates.
struct Weight {
    address token;
    uint16 bps;
}

/// One swap through an allowed router. The vault judges it by its own balance changes and `minOut`.
struct Swap {
    address router;
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    uint256 minOut;
    bytes data;
}

/// What the platform knows about a listed asset. Decimals are stated here and never read from the token.
struct AssetConfig {
    address feed;
    uint8 tokenDecimals;
    uint8 feedDecimals;
    uint32 maxAge;
    uint8 session; // 0 always, 1 US stocks
    uint8 source; // 0 none, 1 Chainlink
    uint16 maxWeightBps;
    address pauseProbe;
    bytes4 pauseSelector;
    bytes4 scheduleSelector; // called on the token; 0 = none
    uint64 haltUntil;
}

/// The author limits the registry checks on every version of a shared portfolio.
struct Limits {
    uint8 minAssets;
    uint8 maxAssets;
    uint16 minWeightBps;
    uint16 maxWeightBps;
    uint16 stepBps;
    uint16 maxTurnoverBps;
    uint32 minInterval;
    uint32 publishDelay;
}

/// One read of a vault for the app and for agents.
struct Snapshot {
    address owner;
    bytes32 indexId;
    uint32 acceptedVersion;
    bool autoFollow;
    address operator;
    address[] tokens;
    uint16[] targetBps;
    uint256[] balances;
    uint256[] prices; // USD per whole token, 1e18
    uint64[] priceUpdatedAt;
    uint64[] lastKeeperAt;
    uint16 lossUsedBps;
}
