// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

/// A Uniswap v3 pool as an oracle reads it: two tokens, the liquidity in range, and `observe`, answered
/// from the pool's own history of ticks. A tick and a liquidity stand from the moment they are set until
/// the next; `observe` adds them up second by second as the real pool does, counting no liquidity as one
/// unit, and reverts with `OLD` when asked for a time before its history starts. Not production code.
contract MockV3Pool {
    struct Step {
        uint256 since;
        int24 tick;
        uint128 liquidity;
    }

    address public token0;
    address public token1;
    Step[] internal steps;
    /// Where the two counters stood when the history starts: a real pool's are anywhere, and wrap.
    int56 internal tickStart;
    uint160 internal perLiquidityStart;
    bool internal broken;
    bool internal short;
    /// The slots the pool keeps observations in. This mock keeps every step whatever the number says.
    uint16 public cardinality = 7200;

    constructor(address token0_, address token1_, int24 tick, uint128 liquidity_) {
        token0 = token0_;
        token1 = token1_;
        steps.push(Step(block.timestamp, tick, liquidity_));
    }

    /// From now on the pool sits at `tick` with `liquidity_` in range.
    function move(int24 tick, uint128 liquidity_) external {
        steps.push(Step(block.timestamp, tick, liquidity_));
    }

    /// From now on the pool sits at `tick`, with the liquidity it had.
    function moveTick(int24 tick) external {
        steps.push(Step(block.timestamp, tick, steps[steps.length - 1].liquidity));
    }

    /// Forgets everything before now: a pool whose history is this short.
    function restart() external {
        Step memory last = steps[steps.length - 1];
        delete steps;
        steps.push(Step(block.timestamp, last.tick, last.liquidity));
    }

    function setCounters(int56 tickStart_, uint160 perLiquidityStart_) external {
        tickStart = tickStart_;
        perLiquidityStart = perLiquidityStart_;
    }

    function setTokens(address token0_, address token1_) external {
        token0 = token0_;
        token1 = token1_;
    }

    function setCardinality(uint16 cardinality_) external {
        cardinality = cardinality_;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, steps[steps.length - 1].tick, 0, cardinality, cardinality, 0, true);
    }

    function setBroken(bool on) external {
        broken = on;
    }

    /// `observe` answers one word.
    function setShort(bool on) external {
        short = on;
    }

    function liquidity() external view returns (uint128) {
        return steps[steps.length - 1].liquidity;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(!broken, "pool down");
        if (short) {
            assembly ("memory-safe") {
                mstore(0x00, 1)
                return(0x00, 0x20)
            }
        }
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            require(secondsAgos[i] <= block.timestamp && block.timestamp - secondsAgos[i] >= steps[0].since, "OLD");
            (tickCumulatives[i], secondsPerLiquidityCumulativeX128s[i]) = _at(block.timestamp - secondsAgos[i]);
        }
    }

    function _at(uint256 time) private view returns (int56 ticks, uint160 perLiquidity) {
        ticks = tickStart;
        perLiquidity = perLiquidityStart;
        for (uint256 i; i < steps.length && steps[i].since < time; ++i) {
            uint256 until = i + 1 < steps.length && steps[i + 1].since < time ? steps[i + 1].since : time;
            uint256 stood = until - steps[i].since;
            uint128 l = steps[i].liquidity == 0 ? 1 : steps[i].liquidity;
            unchecked {
                ticks += int56(int256(steps[i].tick) * int256(stood));
                perLiquidity += uint160((stood << 128) / l);
            }
        }
    }
}
