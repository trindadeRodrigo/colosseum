// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// Stub: the signatures only, so the tests compile and fail. The code follows in the next commit.
contract BasketVault {
    function initialize(address owner_, bytes32 planId_, address config_) external {}

    function deposit(address token, uint256 amount) external {}

    function withdraw(address token, uint256 amount) external {}

    function withdrawAll() external returns (address[] memory skipped) {}

    function owner() external view returns (address) {}

    function planId() external view returns (bytes32) {}

    function config() external view returns (address) {}

    function tokens() external view returns (address[] memory) {}
}
