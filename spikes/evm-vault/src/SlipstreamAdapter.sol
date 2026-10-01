// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IERC20} from "./BasketVault.sol";

interface ICLPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256, int256);
}

/// Spike-only stand-in for a real router: one exact-input swap against one Aerodrome Slipstream
/// (Uniswap-v3-style) pool. Pulls tokenIn from the caller with transferFrom during the callback.
/// Holds nothing between calls. The production path is an aggregator or Aerodrome's own router.
contract SlipstreamAdapter {
    uint160 internal constant MIN_SQRT = 4295128739 + 1;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970342 - 1;
    address private transient _pool;
    address private transient _payer;

    function swapExactIn(address pool, address tokenIn, uint256 amountIn, address recipient) external returns (uint256 out) {
        bool zeroForOne = ICLPool(pool).token0() == tokenIn;
        _pool = pool;
        _payer = msg.sender;
        (int256 a0, int256 a1) =
            ICLPool(pool).swap(recipient, zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT : MAX_SQRT, abi.encode(tokenIn));
        out = uint256(-(zeroForOne ? a1 : a0));
        _pool = address(0);
        _payer = address(0);
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        require(msg.sender == _pool, "not pool");
        address tokenIn = abi.decode(data, (address));
        uint256 owed = uint256(a0 > 0 ? a0 : a1);
        require(IERC20(tokenIn).transferFrom(_payer, msg.sender, owed), "pull failed");
    }
}
