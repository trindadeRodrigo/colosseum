// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Builds Universal Router calldata for a single-pool Uniswap v4 exact-input swap.
/// In production the keeper builds this off-chain; it is here so tests and scripts share it.
library UniV4Calldata {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    // v4-periphery `main` (Universal Router 2.1.x): has the per-hop price field
    struct ExactInputSingleParamsV21 {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    // original v4-periphery (Universal Router 2.0)
    struct ExactInputSingleParamsV20 {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    uint8 internal constant CMD_V4_SWAP = 0x10;
    uint8 internal constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant SETTLE_ALL = 0x0c;
    uint8 internal constant TAKE = 0x0e;
    uint8 internal constant TAKE_ALL = 0x0f;

    /// @param legacy true = Universal Router 2.0 struct, false = 2.1.x struct
    /// @param recipient address(0) = TAKE_ALL to the caller (the vault); else TAKE to `recipient`
    function exactInSingle(
        PoolKey memory key,
        address tokenIn,
        uint256 amountIn,
        uint256 minOut,
        bool legacy,
        address recipient,
        uint256 deadline
    ) internal pure returns (bytes memory) {
        bool zeroForOne = tokenIn == key.currency0;
        address tokenOut = zeroForOne ? key.currency1 : key.currency0;
        bytes[] memory params = new bytes[](3);
        params[0] = legacy
            ? abi.encode(ExactInputSingleParamsV20(key, zeroForOne, uint128(amountIn), uint128(minOut), ""))
            : abi.encode(ExactInputSingleParamsV21(key, zeroForOne, uint128(amountIn), uint128(minOut), 0, ""));
        params[1] = abi.encode(tokenIn, amountIn);
        bytes memory actions;
        if (recipient == address(0)) {
            actions = abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL);
            params[2] = abi.encode(tokenOut, minOut);
        } else {
            actions = abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE);
            params[2] = abi.encode(tokenOut, recipient, uint256(0)); // 0 = full open delta
        }
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        return abi.encodeWithSignature("execute(bytes,bytes[],uint256)", abi.encodePacked(CMD_V4_SWAP), inputs, deadline);
    }
}
