// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

/// A price feed with Chainlink's interface: an answer, the time it was written, and the time its round
/// started (what a sequencer feed reports as the time the sequencer came up). Any of it can be set, and the
/// feed can be made to revert or to answer short. Not production code.
contract MockFeed {
    int256 internal answer;
    uint256 internal updatedAt;
    uint256 internal startedAt;
    bool internal broken;
    bool internal short;

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function setStartedAt(uint256 startedAt_) external {
        startedAt = startedAt_;
    }

    function setBroken(bool on) external {
        broken = on;
    }

    /// Answers fewer bytes than the five words of `latestRoundData`.
    function setShort(bool on) external {
        short = on;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "feed down");
        if (short) {
            assembly ("memory-safe") {
                mstore(0x00, 1)
                return(0x00, 0x20)
            }
        }
        return (1, answer, startedAt, updatedAt, 1);
    }
}

/// A Chainlink price feed with its rounds: `latestRoundData` and `getRoundData`, round ids that carry a
/// phase in their high bits as a Chainlink proxy's do, and a way to lose a round, change the decimals, or
/// stop answering. Not production code.
contract MockRoundFeed {
    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    uint8 public decimals = 8;
    string public description = "TEST / USD";
    uint80 public latestRound;
    mapping(uint80 => Round) internal rounds;
    bool internal broken;
    bool internal roundsBroken;

    constructor() {
        latestRound = uint80(1) << 64;
    }

    /// A new round in the current phase.
    function push(int256 answer, uint256 updatedAt) external returns (uint80 roundId) {
        roundId = ++latestRound;
        rounds[roundId] = Round(answer, updatedAt);
    }

    /// A new aggregator behind the proxy: the next round is the first of a new phase.
    function nextPhase() external {
        latestRound = ((latestRound >> 64) + 1) << 64;
    }

    function drop(uint80 roundId) external {
        delete rounds[roundId];
    }

    function setDecimals(uint8 decimals_) external {
        decimals = decimals_;
    }

    function setBroken(bool on) external {
        broken = on;
    }

    /// `getRoundData` reverts while `latestRoundData` still answers.
    function setRoundsBroken(bool on) external {
        roundsBroken = on;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "feed down");
        Round memory r = rounds[latestRound];
        return (latestRound, r.answer, r.updatedAt, r.updatedAt, latestRound);
    }

    /// A round that was never written answers zeros, as an aggregator does for one it does not hold.
    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken && !roundsBroken, "feed down");
        Round memory r = rounds[roundId];
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }
}
