// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface ICLPool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data) external returns (int256, int256);
}
/// Read-only quoter for any Uniswap-v3-style pool (Aerodrome Slipstream included). Injected with an
/// eth_call state override; never deployed. Reverts inside the swap callback, so no token is paid in.
contract ClQuoter {
    uint160 internal constant MIN_SQRT = 4295128739 + 1;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970342 - 1;
    error Q(int256 a0, int256 a1);
    function quote(address pool, bool zeroForOne, uint256[] calldata amountsIn) external returns (uint256[] memory outs) {
        outs = new uint256[](amountsIn.length);
        for (uint256 i; i < amountsIn.length; i++) {
            try ICLPool(pool).swap(address(this), zeroForOne, int256(amountsIn[i]), zeroForOne ? MIN_SQRT : MAX_SQRT, "") {
                revert("no revert");
            } catch (bytes memory r) {
                if (r.length != 68) { outs[i] = type(uint256).max; continue; }
                int256 a0; int256 a1;
                assembly { a0 := mload(add(r, 36)) a1 := mload(add(r, 68)) }
                outs[i] = uint256(-(zeroForOne ? a1 : a0));
            }
        }
    }
    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external pure { revert Q(a0, a1); }
}
