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

/// The author limits the registry checks on every version of a shared portfolio. One delay, not two:
/// `publishDelay` is both the notice a follower gets and the least time between two versions.
struct Limits {
    uint8 minAssets;
    uint8 maxAssets;
    uint16 minWeightBps;
    uint16 maxWeightBps;
    uint16 stepBps;
    uint16 maxTurnoverBps;
    uint32 publishDelay;
}

/// The keeper's limits (section 5). The config bounds them: see `IVaultConfig.setParams`.
struct Params {
    uint16 toleranceBps;
    uint16 lossCapBps;
    uint16 bandBps;
    uint32 assetCooldown;
    uint32 sessionOpen; // seconds after midnight UTC
    uint32 sessionClose;
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
    bytes32 planId; // the plan this vault holds, so a vault is matched to its plan with no event
}

/// One version of a shared portfolio. `version == 0` means there is none (no pending version).
struct IndexVersion {
    uint32 version;
    uint64 effectiveAt;
    bytes32 metaHash;
    Weight[] components;
}

/// Everything the app shows about a shared portfolio, in one read.
struct IndexInfo {
    address creator;
    bytes32 familyId;
    IndexVersion active;
    IndexVersion pending;
}
