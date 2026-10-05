// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// TEST NETWORK ONLY. A stand-in for Chainlink's L2 sequencer uptime feed, which no test network has
/// (docs/vault/research/test-networks.md, Base Sepolia). It answers as the real one does: `answer` 0 while
/// the sequencer is up and 1 while it is down, and `startedAt` the time the status last changed. The owner
/// flips it, so the vault's check (up, and for at least an hour) can be seen to run on a test network.
///
/// Base only: Robinhood Chain has no sequencer feed and its config names none.
contract StubSequencerFeed is Ownable2Step {
    uint8 public constant decimals = 0;
    string public constant description = "L2 Sequencer Uptime Status Feed (test network stub)";
    uint256 public constant version = 1;

    uint80 public latestRound = 1;
    bool public down;
    uint64 public changedAt;

    event StatusSet(bool down, uint256 changedAt);

    error ChangedInTheFuture(uint256 changedAt, uint256 now);

    /// Up since `changedAt_`, a time not after now. Zero is now.
    constructor(address owner_, uint256 changedAt_) Ownable(owner_) {
        uint256 since = changedAt_ == 0 ? block.timestamp : changedAt_;
        require(since <= block.timestamp, ChangedInTheFuture(since, block.timestamp));
        changedAt = uint64(since);
        emit StatusSet(false, since);
    }

    /// Down or up from now. Setting the status it already has changes nothing, as the real feed only starts
    /// a round on a change.
    function setDown(bool down_) external onlyOwner {
        if (down_ == down) return;
        down = down_;
        changedAt = uint64(block.timestamp);
        ++latestRound;
        emit StatusSet(down_, block.timestamp);
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (latestRound, down ? int256(1) : int256(0), changedAt, changedAt, latestRound);
    }
}
