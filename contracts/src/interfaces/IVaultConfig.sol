// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {AssetConfig} from "./Types.sol";

/// The platform's per-chain settings a vault reads: the listed assets with their price feeds, and the
/// allowed routers. Nothing here is a constant in the vault: on mainnet the values are Uniswap's router and
/// Chainlink feeds, on a test network our own test exchange and test feeds.
///
/// This is the config half of `IVaultFactory` (section 3.8), split out so the vault depends only on what it
/// reads. The factory of EVM-2 implements both.
interface IVaultConfig {
    event AssetSet(address indexed token, AssetConfig config);
    event RouterSet(address indexed router, uint8 pull);
    event AdminProposed(address indexed pendingAdmin);
    event AdminChanged(address indexed previousAdmin, address indexed newAdmin);

    error NotAdmin(address caller);
    error NotPendingAdmin(address caller);
    error ZeroAddress();
    error FeedRequired(address token);
    error InvalidPull(uint8 pull);

    /// The settings of a listed asset; all zero for a token that is not listed.
    function asset(address token) external view returns (AssetConfig memory);

    /// Every listed asset.
    function assets() external view returns (address[] memory);

    /// Whether a token is on the platform's list. Not in section 3.8: `asset()` cannot say it, because a
    /// listed asset with no price source has an all-zero feed.
    function isAsset(address token) external view returns (bool);

    /// How an allowed router pulls its input: 0 not allowed, 1 direct (`transferFrom`), 2 through Permit2.
    function routerPull(address router) external view returns (uint8);
}
