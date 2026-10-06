// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// TEST NETWORK ONLY. A price contract with Chainlink's aggregator interface (`decimals`, `description`,
/// `version`, `latestRoundData`, `getRoundData`), whose rounds are written by one price writer the owner
/// names, or by the owner. The vault reads it exactly as it reads a Chainlink feed: the asset's `feed` and
/// its `averageFeed` are each one of these.
///
/// The price copier (TNET-2, `scripts/testnet/robinhood/prices.ts`) writes each round with the mainnet
/// feed's own answer and `updatedAt`, so a test price moves in session and goes stale off session as the
/// real one does. What the contract holds to, whoever writes:
///   - an answer above zero;
///   - a time newer than the round before, so a round is never replaced by an older one;
///   - a time at most `MAX_AHEAD` past the chain's clock.
/// `startedAt` is the round's `updatedAt`, and `answeredInRound` its id, as Chainlink's feeds answer today.
contract TestPriceFeed is Ownable2Step {
    /// How far past the chain's clock a round may be stamped: the source chain's clock and this one's differ
    /// by a few seconds.
    uint256 public constant MAX_AHEAD = 60;

    struct Round {
        int256 answer;
        uint64 updatedAt;
    }

    uint8 public immutable decimals;
    string public description;
    uint256 public constant version = 1;

    address public writer;
    uint80 public latestRound;
    mapping(uint80 => Round) private _rounds;

    event WriterSet(address indexed writer);
    /// Chainlink's event for a new round.
    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    error NotWriter(address caller);
    error AnswerNotPositive(int256 answer);
    error NotNewer(uint256 updatedAt, uint256 latest);
    error StampedAhead(uint256 updatedAt, uint256 now);
    error NoDataPresent();

    constructor(uint8 decimals_, string memory description_, address owner_, address writer_) Ownable(owner_) {
        decimals = decimals_;
        description = description_;
        writer = writer_;
        emit WriterSet(writer_);
    }

    function setWriter(address writer_) external onlyOwner {
        writer = writer_;
        emit WriterSet(writer_);
    }

    /// A new round: `answer` in this feed's decimals, true at `updatedAt` (unix seconds).
    function write(int256 answer, uint256 updatedAt) external returns (uint80 roundId) {
        require(msg.sender == writer || msg.sender == owner(), NotWriter(msg.sender));
        require(answer > 0, AnswerNotPositive(answer));
        uint256 latest = _rounds[latestRound].updatedAt;
        require(updatedAt > latest, NotNewer(updatedAt, latest));
        require(updatedAt <= block.timestamp + MAX_AHEAD, StampedAhead(updatedAt, block.timestamp));
        roundId = latestRound + 1;
        latestRound = roundId;
        // `updatedAt` is at most the clock plus a minute: it fits in 64 bits for the life of any chain.
        _rounds[roundId] = Round({answer: answer, updatedAt: uint64(updatedAt)});
        emit AnswerUpdated(answer, roundId, updatedAt);
    }

    /// Before the first round there is no data, as a new Chainlink aggregator answers.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return getRoundData(latestRound);
    }

    function getRoundData(uint80 roundId)
        public
        view
        returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        Round memory r = _rounds[roundId];
        require(r.updatedAt != 0, NoDataPresent());
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }
}
