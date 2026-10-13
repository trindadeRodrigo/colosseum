// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// The price a concentrated-liquidity tick stands for: `1.0001^tick`, the amount of a pool's token1 one raw
/// unit of its token0 is worth.
///
/// Written for this repository. The method is exponentiation by squaring over a table of
/// `1.0001^(-2^i)`: the factors of the bits set in the tick are multiplied together in 128-bit fixed point.
/// Uniswap v3's `TickMath` (GPL-2.0-or-later) uses the same method to compute the square root of this
/// price from a table of `1.0001^(-2^i / 2)`; none of its code or its table is used here. The table below
/// is printed by `script/tick-table.mjs` in exact integers, and `test/TickPrice.t.sol` holds each entry to
/// the square of the one before.
///
/// Rounding: every step rounds down, and the last division allows for the most the steps can have lost, so
/// the answer is never above the true value. It is below it by less than one unit plus one part in 2^58.
library TickPrice {
    /// The ticks this library prices: `1.0001^tick` between 2^-64 and 2^64. Outside them the 128-bit
    /// working value has too few digits left. A pool of two real tokens with at most 18 decimals each sits
    /// far inside (a $230 stock against a 6-decimal dollar is tick 222,000).
    int24 internal constant MAX_TICK = 443_636;

    uint256 private constant Q128 = 1 << 128;
    /// The most `_shrunk` can be under the true value: two units a step, nineteen steps.
    uint256 private constant MOST_LOST = 38;

    error TickOutOfRange(int256 tick);

    /// `1.0001^tick * mulBy / divBy`, rounded down. `mulBy` is at most 10^36 and `divBy` at most 10^18:
    /// the powers of ten that move a raw price to a feed's decimals.
    function priceAt(int256 tick, uint256 mulBy, uint256 divBy) internal pure returns (uint256) {
        require(tick >= -MAX_TICK && tick <= MAX_TICK, TickOutOfRange(tick));
        // 2^128 * 1.0001^(-|tick|): between 2^64 and 2^128, and at most MOST_LOST under the true value.
        uint256 shrunk = _shrunk(uint256(tick < 0 ? -tick : tick));
        if (tick <= 0) return Math.mulDiv(shrunk, mulBy, Q128 * divBy);
        return Math.mulDiv(Q128, mulBy, (shrunk + MOST_LOST) * divBy);
    }

    /// 2^128 * 1.0001^(-magnitude), rounded down at every step.
    function _shrunk(uint256 magnitude) private pure returns (uint256 r) {
        r = Q128;
        unchecked {
            // Each factor is under 2^128 and so is `r` after the first, so no product passes 2^256.
            if (magnitude & 0x1 != 0) r = (r * 0xfff97272373d413259a46990580e2139) >> 128;
            if (magnitude & 0x2 != 0) r = (r * 0xfff2e50f5f656932ef12357cf3c7fdcb) >> 128;
            if (magnitude & 0x4 != 0) r = (r * 0xffe5caca7e10e4e61c3624eaa0941ccf) >> 128;
            if (magnitude & 0x8 != 0) r = (r * 0xffcb9843d60f6159c9db58835c926643) >> 128;
            if (magnitude & 0x10 != 0) r = (r * 0xff973b41fa98c081472e6896dfb254bf) >> 128;
            if (magnitude & 0x20 != 0) r = (r * 0xff2ea16466c96a3843ec78b326b52860) >> 128;
            if (magnitude & 0x40 != 0) r = (r * 0xfe5dee046a99a2a811c461f1969c3052) >> 128;
            if (magnitude & 0x80 != 0) r = (r * 0xfcbe86c7900a88aedcffc83b479aa3a3) >> 128;
            if (magnitude & 0x100 != 0) r = (r * 0xf987a7253ac413176f2b074cf7815e53) >> 128;
            if (magnitude & 0x200 != 0) r = (r * 0xf3392b0822b70005940c7a398e4b70f2) >> 128;
            if (magnitude & 0x400 != 0) r = (r * 0xe7159475a2c29b7443b29c7fa6e889d8) >> 128;
            if (magnitude & 0x800 != 0) r = (r * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (magnitude & 0x1000 != 0) r = (r * 0xa9f746462d870fdf8a65dc1f90e061e4) >> 128;
            if (magnitude & 0x2000 != 0) r = (r * 0x70d869a156d2a1b890bb3df62baf32f6) >> 128;
            if (magnitude & 0x4000 != 0) r = (r * 0x31be135f97d08fd981231505542fcfa5) >> 128;
            if (magnitude & 0x8000 != 0) r = (r * 0x9aa508b5b7a84e1c677de54f3e99bc8) >> 128;
            if (magnitude & 0x10000 != 0) r = (r * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (magnitude & 0x20000 != 0) r = (r * 0x2216e584f5fa1ea926041bedfe97) >> 128;
            if (magnitude & 0x40000 != 0) r = (r * 0x48a170391f7dc42444e8fa2) >> 128;
        }
    }

    /// The table, for the test that checks it.
    function factor(uint256 i) internal pure returns (uint256) {
        return _shrunk(1 << i);
    }
}
