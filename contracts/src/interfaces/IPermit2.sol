// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// The two calls the vault makes on Permit2 (the allowance half: `IAllowanceTransfer`).
interface IPermit2 {
    /// Lets `spender` take up to `amount` of the caller's `token` through Permit2 until `expiration`.
    /// An `expiration` of 0 means the end of this block.
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;

    function allowance(address user, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}
