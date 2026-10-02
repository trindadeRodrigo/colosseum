// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface ICLPool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256, int256);
}

/// Read-only quoter for any Uniswap-v3-style pool (Aerodrome Slipstream included). Injected with an
/// eth_call state override; never deployed. Reverts inside the swap callback, so no token is paid in.
/// From docs/vault/research/design-v2/backend-evidence/ClQuoter.sol, plus the amount taken in and a gas cap.
contract ClQuoter {
    uint160 internal constant MIN_SQRT = 4295128739 + 1;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970342 - 1;

    error Q(int256 a0, int256 a1);

    /// For each amount, smallest first: what the pool takes in and what it pays out. `ins[i]` below
    /// `amountsIn[i]` means the pool ran out of liquidity. The loop stops at the first swap that fails or
    /// needs more than `gasPerSwap`, or when less than that is left; entries from there on stay 0 (not quoted).
    function quote(address pool, bool zeroForOne, uint256[] calldata amountsIn, uint256 gasPerSwap)
        external
        returns (uint256[] memory ins, uint256[] memory outs)
    {
        ins = new uint256[](amountsIn.length);
        outs = new uint256[](amountsIn.length);
        for (uint256 i; i < amountsIn.length; i++) {
            if (gasleft() < gasPerSwap + 100000) break;
            try ICLPool(pool).swap{gas: gasPerSwap}(
                address(this), zeroForOne, int256(amountsIn[i]), zeroForOne ? MIN_SQRT : MAX_SQRT, ""
            ) {
                revert("no revert");
            } catch (bytes memory r) {
                if (r.length != 68 || bytes4(r) != Q.selector) break;
                int256 a0;
                int256 a1;
                assembly {
                    a0 := mload(add(r, 36))
                    a1 := mload(add(r, 68))
                }
                (int256 paid, int256 got) = zeroForOne ? (a0, a1) : (a1, a0);
                if (paid <= 0 || got >= 0) break;
                ins[i] = uint256(paid);
                outs[i] = uint256(-got);
            }
        }
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external pure {
        revert Q(a0, a1);
    }
}
