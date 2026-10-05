// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

/// Builds Universal Router 2.1.x call data for an exact-input swap through one Uniswap v4 pool. From the rig
/// (`spikes/evm-vault`); in production the app and the keeper build it off-chain. Tests only.
library UniV4Calldata {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// v4-periphery `main`, the shape Universal Router 2.1.x takes: it has the per-hop price field.
    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    uint8 internal constant CMD_V4_SWAP = 0x10;
    uint8 internal constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant SETTLE_ALL = 0x0c;
    uint8 internal constant TAKE = 0x0e;
    uint8 internal constant TAKE_ALL = 0x0f;

    /// @param recipient The zero address sends the output to the caller, the vault (`TAKE_ALL`). Any other
    /// address gets it instead (`TAKE`): what a hostile caller would build.
    function exactInSingle(
        PoolKey memory key,
        address tokenIn,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        uint256 deadline
    ) internal pure returns (bytes memory) {
        bool zeroForOne = tokenIn == key.currency0;
        address tokenOut = zeroForOne ? key.currency1 : key.currency0;
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams(key, zeroForOne, uint128(amountIn), uint128(minOut), 0, ""));
        params[1] = abi.encode(tokenIn, amountIn);
        bytes memory actions;
        if (recipient == address(0)) {
            actions = abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL);
            params[2] = abi.encode(tokenOut, minOut);
        } else {
            actions = abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE);
            // An amount of 0 means everything the pool owes.
            params[2] = abi.encode(tokenOut, recipient, uint256(0));
        }
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        return
            abi.encodeWithSignature("execute(bytes,bytes[],uint256)", abi.encodePacked(CMD_V4_SWAP), inputs, deadline);
    }
}
