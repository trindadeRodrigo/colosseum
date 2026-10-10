// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TickPrice} from "../src/price/TickPrice.sol";

contract TickPriceHarness {
    function priceAt(int256 tick, uint256 mulBy, uint256 divBy) external pure returns (uint256) {
        return TickPrice.priceAt(tick, mulBy, divBy);
    }

    function factor(uint256 i) external pure returns (uint256) {
        return TickPrice.factor(i);
    }
}

/// The tick-to-price maths: its table, its answers against values worked in exact integers
/// (`node script/tick-table.mjs --vectors`), which way it rounds, and that it rises with the tick and
/// never overflows across the ticks it takes.
contract TickPriceTest is Test {
    int256 internal constant MAX = 443_636;
    TickPriceHarness internal lib;

    function setUp() public {
        lib = new TickPriceHarness();
    }

    /// The first entry is 2^128 * 10000 / 10001, and each next one is the square of the one before: a
    /// rounded-down entry squared is at most two units under the next.
    function test_table_isTheSquaresOfItsFirstEntry() public view {
        assertEq(lib.factor(0), (uint256(1) << 128) * 10_000 / 10_001);
        for (uint256 i; i < 18; ++i) {
            uint256 squared = (lib.factor(i) * lib.factor(i)) >> 128;
            uint256 next = lib.factor(i + 1);
            assertLe(squared, next, "an entry under the square of the one before");
            assertLe(next - squared, 2, "an entry not the square of the one before");
        }
    }

    function _check(int256 tick, int256 scale, uint256 exact) internal view {
        uint256 mulBy = scale >= 0 ? 10 ** uint256(scale) : 1;
        uint256 divBy = scale >= 0 ? 1 : 10 ** uint256(-scale);
        uint256 got = lib.priceAt(tick, mulBy, divBy);
        // Never above the true value; under it by less than one unit plus one part in 2^58.
        assertLe(got, exact, "rounded up");
        assertLe(exact - got, 1 + (exact >> 58), "too far under");
    }

    function test_priceAt_againstExactValues() public view {
        _check(0, 20, 100000000000000000000);
        _check(1, 20, 100010000000000000000);
        _check(-1, 20, 99990000999900009999);
        _check(10, 8, 100100045);
        _check(-10, 8, 99900054);
        _check(100, 20, 101004966209287656885);
        _check(-101, 20, 98995133360784869684);
        // A $230 stock of 18 decimals against a 6-decimal dollar, in a feed's 8: the NVDA pool's tick.
        _check(-221_937, 20, 23008084035);
        // The same tick the other way up, with decimals that divide.
        _check(221_937, -4, 434629);
        _check(-209_730, 20, 77982512515);
        _check(-230_270, 20, 10000022031);
        // The ends of the range, at the largest and the smallest scale.
        _check(443_636, 0, 18446050711097703529);
        _check(443_636, 36, 18446050711097703529776342895396472065568967222426633323);
        _check(443_636, -18, 18);
        _check(-443_636, 36, 54212146310449513);
        _check(-443_636, 0, 0);
    }

    /// Small answers are exactly the whole part of the true value.
    function test_priceAt_smallAnswers_areExact() public view {
        assertEq(lib.priceAt(0, 1e20, 1), 1e20);
        assertEq(lib.priceAt(-221_937, 1e20, 1), 23008084035);
        assertEq(lib.priceAt(-209_730, 1e20, 1), 77982512515);
        assertEq(lib.priceAt(221_937, 1, 1e4), 434629);
        assertEq(lib.priceAt(-10, 1e8, 1), 99900054);
        assertEq(lib.priceAt(10, 1e8, 1), 100100045);
    }

    function test_priceAt_outsideTheRange_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(TickPrice.TickOutOfRange.selector, MAX + 1));
        lib.priceAt(MAX + 1, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(TickPrice.TickOutOfRange.selector, -MAX - 1));
        lib.priceAt(-MAX - 1, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(TickPrice.TickOutOfRange.selector, int256(887_272)));
        lib.priceAt(887_272, 1, 1);
    }

    /// Across the whole range and every scale the feed can ask for, nothing overflows, a higher tick is
    /// never a lower price, and one tick is one hundredth of a percent.
    function testFuzz_priceAt_risesWithTheTick(int256 tick, uint8 up, uint8 down) public view {
        tick = bound(tick, -MAX, MAX - 1);
        uint256 mulBy = 10 ** bound(up, 0, 36);
        uint256 divBy = 10 ** bound(down, 0, 18);
        uint256 low = lib.priceAt(tick, mulBy, divBy);
        uint256 high = lib.priceAt(tick + 1, mulBy, divBy);
        assertGe(high, low);
        // Where there are digits enough to see it: high / low is 1.0001, to a part in a million.
        if (low > 1e12) {
            assertGt(high, low);
            assertApproxEqRel(high * 10_000, low * 10_001, 1e12);
        }
    }

    /// A tick and its opposite are each other's inverse.
    function testFuzz_priceAt_aTickAndItsOpposite(int256 tick) public view {
        tick = bound(tick, 0, 200_000);
        uint256 a = lib.priceAt(tick, 1e30, 1);
        uint256 b = lib.priceAt(-tick, 1e30, 1);
        // a * b is 1e60, to a part in a billion (the smaller of the two has at least 21 digits).
        assertApproxEqRel(a * b / 1e30, 1e30, 1e9);
    }
}
