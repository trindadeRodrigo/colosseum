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
