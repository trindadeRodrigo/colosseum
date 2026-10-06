// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IVaultConfig} from "../../src/interfaces/IVaultConfig.sol";
import {AssetConfig} from "../../src/interfaces/Types.sol";
import {TestMarket} from "../../testnet/TestMarket.sol";
import {TestPriceFeed} from "../../testnet/TestPriceFeed.sol";

interface IAggregator {
    function description() external view returns (string memory);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80);
}

/// TEST NETWORK ONLY. One round of the price copier for the Robinhood Chain test network (TNET-2): reads
/// each test token's Chainlink feed on Robinhood Chain mainnet, read only, and writes its test price
/// contract and its average on the test network, then moves each pool back to its test price. The loop
/// around it is `scripts/testnet/robinhood/prices.ts`.
///
///   forge script script/testnet/CopyPrices.s.sol --rpc-url <test network> --sender <price writer>
///
/// is a dry run: it prints what it would write. With `PRICE_WRITER_KEY` in the environment and
/// `--broadcast` it sends, signed by the price writer the record names; the deploy key is refused.
///
/// The price is the feed's own round, its answer and its `updatedAt`, written only when newer than what the
/// test network holds, so a test price moves in session and goes stale off session as the real one does.
/// No Chainlink feed of an average exists on Robinhood Chain: the average is the feed's own rounds weighted
/// by how long each held over the hour before the mainnet block read, stamped with that block's time. It is
/// written with each new round, and between rounds at most every `AVERAGE_EVERY` while its value moves: for
/// the hour after a round it catches up with it, then stays, so a closed market costs no transactions. A value is refused, and nothing of its token written, when it is
/// not above zero, stamped more than a minute ahead of the test network's clock, outside the vault's range
/// for the token (with `FACTORY` set), or further from what the test network holds than `MAX_JUMP_BPS` per
/// hour since that was stamped (at least one hour's worth, at most `MAX_GAP_JUMP_BPS`): the Solana copier's
/// rules (TNET-5).
contract CopyPrices is Script {
    using stdJson for string;

    string internal constant SOURCE_RPC = "https://rpc.mainnet.chain.robinhood.com";
    uint256 public constant WINDOW = 1 hours;
    uint256 public constant AVERAGE_EVERY = 5 minutes;
    uint256 public constant MAX_AHEAD = 60;
    uint256 public constant MAX_GAP_JUMP_BPS = 5000;
    /// The furthest back the average looks for rounds; a stock feed writes a few an hour.
    uint256 public constant MAX_ROUNDS_BACK = 64;
    string internal constant NO_ANSWER = "the source feed did not answer";

    struct Asset {
        string symbol;
        address token;
        address feed;
        address average;
        address source;
        string sourceDescription;
    }

    struct Record {
        address admin;
        address priceWriter;
        address market;
        Asset[] assets;
    }

    /// What mainnet says of one asset, or why it says nothing.
    struct Reading {
        string why;
        /// How much of the hour before the block the average's rounds cover, in seconds.
        uint256 covered;
        int256 answer;
        uint256 updatedAt;
        int256 average;
        uint256 averageAt;
    }

    struct Result {
        uint256 written;
        uint256 unchanged;
        uint256 refused;
        uint256 recentred;
    }

    error NotTheWriter(address signer, address writer);
    /// The chain written to is a mainnet: Robinhood Chain's or Base's.
    error MainnetRefused(uint256 chainId);
    /// The chain read from is not Robinhood Chain mainnet.
    error SourceNotMainnet(uint256 chainId);
    error DeployKey(address signer);

    function run() external returns (Result memory result) {
        Record memory r = readRecord(vm.envOr("TESTNET_RECORD", string("script/testnet/deployed/46630.json")));
        uint256 testFork = vm.activeFork();
        uint256 sourceFork = vm.createFork(vm.envOr("SOURCE_RPC_URL", SOURCE_RPC));

        vm.selectFork(sourceFork);
        checkSource(block.chainid);
        Reading[] memory readings = readAll(r.assets, block.timestamp);
        console2.log(string.concat("source: Robinhood Chain mainnet, block ", vm.toString(block.number)));

        vm.selectFork(testFork);
        uint256 key = vm.envOr("PRICE_WRITER_KEY", uint256(0));
        address signer = key == 0 ? r.priceWriter : vm.addr(key);
        checkSigner(r, signer);
        if (key == 0) vm.startBroadcast(signer);
        else vm.startBroadcast(key);
        result = copy(r, readings, vm.envOr("MAX_JUMP_BPS", uint256(1000)), vm.envOr("FACTORY", address(0)));
        vm.stopBroadcast();
        console2.log(
            string.concat(
                "round: wrote ",
                vm.toString(result.written),
                ", unchanged ",
                vm.toString(result.unchanged),
                ", refused ",
                vm.toString(result.refused),
                ", pools re-centred ",
                vm.toString(result.recentred)
            )
        );
    }

    /// The copier signs with the price writer the record names, and never with the deploy key.
    function checkSigner(Record memory r, address signer) public pure {
        require(signer != r.admin, DeployKey(signer));
        require(signer == r.priceWriter, NotTheWriter(signer, r.priceWriter));
    }

    /// The prices are read from Robinhood Chain mainnet and nowhere else.
    function checkSource(uint256 chainId) public pure {
        require(chainId == 4663, SourceNotMainnet(chainId));
    }

    // ---- reading mainnet

    /// Every asset's reading. A feed that reverts or a call that fails refuses that asset alone: every read
    /// of a source is a low-level call (a script cannot call itself to catch a revert).
    function readAll(Asset[] memory assets, uint256 now_) public view returns (Reading[] memory readings) {
        readings = new Reading[](assets.length);
        for (uint256 i; i < assets.length; ++i) {
            readings[i] = readSource(assets[i], now_);
        }
    }

    /// The feed's latest round, and its average over the `WINDOW` before `now`: each round's answer weighted
    /// by the time it held, the latest held up to `now`. With no earlier round inside the window, the
    /// average is the latest answer.
    function readSource(Asset memory a, uint256 now_) public view returns (Reading memory reading) {
        IAggregator feed = IAggregator(a.source);
        (bool ok, bytes memory ret) = address(feed).staticcall(abi.encodeCall(IAggregator.description, ()));
        if (!ok || ret.length < 64) {
            reading.why = NO_ANSWER;
            return reading;
        }
        string memory said = abi.decode(ret, (string));
        if (keccak256(bytes(said)) != keccak256(bytes(a.sourceDescription))) {
            reading.why = string.concat("the source feed says it is ", said);
            return reading;
        }
        (ok, ret) = address(feed).staticcall(abi.encodeCall(IAggregator.latestRoundData, ()));
        if (!ok || ret.length < 160) {
            reading.why = NO_ANSWER;
            return reading;
        }
        (uint80 id, int256 answer,, uint256 updatedAt,) = abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
        if (answer <= 0 || updatedAt == 0 || updatedAt > now_) {
            reading.why = "the source holds no price";
            return reading;
        }
        reading.answer = answer;
        reading.updatedAt = updatedAt;
        reading.averageAt = now_;

        uint256 start = now_ > WINDOW ? now_ - WINDOW : 0;
        uint256 upTo = now_;
        uint256 sum;
        uint256 held;
        for (uint256 k; k < MAX_ROUNDS_BACK; ++k) {
            uint256 from = updatedAt > start ? updatedAt : start;
            if (upTo > from) {
                sum += uint256(answer) * (upTo - from);
                held += upTo - from;
            }
            // A round id is the phase in its top 16 bits and the round in the phase below: the first round
            // of a phase has no earlier one to ask for.
            if (updatedAt <= start || uint64(id) <= 1) break;
            (bool ok, bytes memory ret) = address(feed).staticcall(abi.encodeCall(IAggregator.getRoundData, (id - 1)));
            if (!ok || ret.length < 160) break;
            (, int256 before,, uint256 beforeAt,) = abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
            if (before <= 0 || beforeAt == 0 || beforeAt > updatedAt) break;
            upTo = updatedAt;
            id -= 1;
            answer = before;
            updatedAt = beforeAt;
        }
        reading.average = held == 0 ? reading.answer : int256(sum / held);
        reading.covered = held;
    }

    // ---- writing the test network

    /// Writes what is newer and passes, as the caller, then re-centres every pool off its test price.
    function copy(Record memory r, Reading[] memory readings, uint256 maxJumpBps, address factory)
        public
        returns (Result memory result)
    {
        require(block.chainid != 4663 && block.chainid != 8453, MainnetRefused(block.chainid));
        TestMarket market = TestMarket(r.market);
        for (uint256 i; i < r.assets.length; ++i) {
            Asset memory a = r.assets[i];
            Reading memory reading = readings[i];
            if (bytes(reading.why).length != 0) {
                _refuse(result, a.symbol, reading.why);
                continue;
            }
            (int256 heldPrice, uint256 heldPriceAt) = _held(a.feed);
            (int256 heldAverage, uint256 heldAverageAt) = _held(a.average);
            bool newerPrice = reading.updatedAt > heldPriceAt;
            // The average goes with each new round; between rounds it catches up, at most every five
            // minutes and only while it moves, so a market that has closed costs nothing.
            bool newerAverage = reading.averageAt > heldAverageAt
                && (newerPrice || (reading.averageAt >= heldAverageAt + AVERAGE_EVERY && reading.average != heldAverage));
            if (!newerPrice && !newerAverage) {
                ++result.unchanged;
                console2.log(string.concat("  ", a.symbol, ": unchanged"));
                continue;
            }
            (uint256 min, uint256 max) = _range(factory, a.token);
            string memory why;
            if (newerPrice) {
                why = refusal("price", reading.answer, reading.updatedAt, heldPrice, heldPriceAt, min, max, maxJumpBps);
            }
            if (bytes(why).length == 0 && newerAverage) {
                why = refusal(
                    "average", reading.average, reading.averageAt, heldAverage, heldAverageAt, min, max, maxJumpBps
                );
            }
            if (bytes(why).length != 0) {
                _refuse(result, a.symbol, why);
                continue;
            }
            string memory line = string.concat("  ", a.symbol, ": wrote");
            if (newerPrice) {
                TestPriceFeed(a.feed).write(reading.answer, reading.updatedAt);
                line = string.concat(line, " price ", _dollars(reading.answer), " at ", vm.toString(reading.updatedAt));
            }
            if (newerAverage) {
                TestPriceFeed(a.average).write(reading.average, reading.averageAt);
                line =
                    string.concat(line, " average ", _dollars(reading.average), " at ", vm.toString(reading.averageAt));
                // The walk back stopped early (the feed's first round, a failed read, or `MAX_ROUNDS_BACK`).
                if (reading.covered < WINDOW) {
                    line = string.concat(line, " (over ", vm.toString(reading.covered), " s of the hour)");
                }
            }
            ++result.written;
            console2.log(line);
        }
        for (uint256 i; i < r.assets.length; ++i) {
            address token = r.assets[i].token;
            // A pool whose price contract has no round yet has no test price to go back to.
            if (TestPriceFeed(r.assets[i].feed).latestRound() == 0) continue;
            uint256 drift = market.driftOf(token);
            if (drift <= market.driftBps()) continue;
            market.recentre(token);
            ++result.recentred;
            console2.log(
                string.concat("  ", r.assets[i].symbol, ": pool re-centred from ", vm.toString(drift), " bps off")
            );
        }
    }

    /// Why a value must not be written, or nothing. `held` is what the test network holds for it, stamped
    /// `heldAt`; `min` and `max` the vault's range, zero for none.
    function refusal(
        string memory what,
        int256 value,
        uint256 stamp,
        int256 held,
        uint256 heldAt,
        uint256 min,
        uint256 max,
        uint256 maxJumpBps
    ) public view returns (string memory) {
        if (value <= 0) return string.concat(what, " is not above zero");
        if (stamp > block.timestamp + MAX_AHEAD) {
            return string.concat(what, " is stamped ", vm.toString(stamp - block.timestamp), " s ahead of the clock");
        }
        uint256 v = uint256(value);
        if (max != 0 && (v < min || v > max)) {
            return string.concat(
                what,
                " ",
                _dollars(value),
                " is outside the vault's range ",
                _dollars(int256(min)),
                " to ",
                _dollars(int256(max)),
                "; if it persists, a person checks the source and moves the range (setAsset)"
            );
        }
        if (held > 0) {
            uint256 before = uint256(held);
            uint256 hours_ = heldAt < block.timestamp ? (block.timestamp - heldAt) / 1 hours : 0;
            uint256 allowed = maxJumpBps * (hours_ < 1 ? 1 : hours_);
            if (allowed > MAX_GAP_JUMP_BPS) allowed = MAX_GAP_JUMP_BPS;
            uint256 move = v > before ? v - before : before - v;
            if (move * 10_000 > before * allowed) {
                return string.concat(
                    what,
                    " ",
                    _dollars(value),
                    " is more than ",
                    vm.toString(allowed),
                    " bps from the ",
                    _dollars(held),
                    " the test network holds; if it persists, a person checks the source and writes it with the admin key"
                );
            }
        }
        return "";
    }

    // ---- the record

    function readRecord(string memory path) public view returns (Record memory r) {
        string memory json = vm.readFile(path);
        r.admin = json.readAddress(".admin");
        r.priceWriter = json.readAddress(".priceWriter");
        r.market = json.readAddress(".market");
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".tokens[", vm.toString(n), "]"))) ++n;
        r.assets = new Asset[](n);
        for (uint256 i; i < n; ++i) {
            string memory e = string.concat(".tokens[", vm.toString(i), "]");
            r.assets[i] = Asset({
                symbol: json.readString(string.concat(e, ".symbol")),
                token: json.readAddress(string.concat(e, ".address")),
                feed: json.readAddress(string.concat(e, ".feed")),
                average: json.readAddress(string.concat(e, ".average")),
                source: json.readAddress(string.concat(e, ".source")),
                sourceDescription: json.readString(string.concat(e, ".sourceDescription"))
            });
        }
    }

    function _held(address feed) private view returns (int256 answer, uint256 updatedAt) {
        (bool ok, bytes memory ret) = feed.staticcall(abi.encodeCall(IAggregator.latestRoundData, ()));
        if (!ok || ret.length < 160) return (0, 0);
        (, answer,, updatedAt,) = abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
    }

    function _range(address factory, address token) private view returns (uint256 min, uint256 max) {
        if (factory == address(0)) return (0, 0);
        AssetConfig memory c = IVaultConfig(factory).asset(token);
        return (c.minPrice, c.maxPrice);
    }

    function _refuse(Result memory result, string memory symbol, string memory why) private pure {
        ++result.refused;
        console2.log(string.concat("  ", symbol, ": refused, ", why));
    }

    /// An 8-decimal answer as dollars.
    function _dollars(int256 value) private pure returns (string memory) {
        uint256 v = value < 0 ? uint256(-value) : uint256(value);
        string memory cents = vm.toString(v % 1e8 + 1e8);
        bytes memory c = bytes(cents);
        bytes memory frac = new bytes(8);
        for (uint256 i; i < 8; ++i) {
            frac[i] = c[i + 1];
        }
        return string.concat(value < 0 ? "-" : "", vm.toString(v / 1e8), ".", string(frac));
    }
}
