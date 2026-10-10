// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TestnetOnly} from "./TestnetOnly.sol";

/// TEST NETWORK ONLY. A plain ERC-20 whose supply the team controls: the test cash of an EVM test network
/// (`decimals` 6, as USDG and USDC have), and the base of the test stock tokens. The admin names who may
/// mint and burn: the deploy key while it seeds the pools, and later the hand-out of TNET-7.
///
/// Nothing here is on a vault's path but the ERC-20 calls. It leaves Permit2's allowance alone: a token
/// that fixed it at infinity could not be sold through a router that pulls with Permit2 (contracts/README.md,
/// known limits).
contract TestToken is TestnetOnly, ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address admin) ERC20(name_, symbol_) {
        _decimals = decimals_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// The issuer's burn: from any holder, as Robinhood's stock tokens have it.
    function burn(address from, uint256 amount) external onlyRole(MINTER_ROLE) {
        _burn(from, amount);
    }
}
