// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {CopyPrices} from "../../script/testnet/CopyPrices.s.sol";
import {TestPriceFeed} from "../../testnet/TestPriceFeed.sol";
import {KitFixture} from "../helpers/KitFixture.sol";

/// The price copier's round (`script/testnet/CopyPrices.s.sol`) on the kit's test network, with a test price
/// contract per token standing in for its mainnet Chainlink feed, under the same description. What it reads,
/// what it writes, what it refuses, and the pools it moves.
contract CopyPricesTest is KitFixture {
    /// Ten minutes after the kit: the averages the kit wrote are more than five minutes old.
    uint256 internal constant T0 = KIT_TIME + 600;

    CopyPrices internal copier;
    CopyPrices.Record internal record;
    TestPriceFeed[] internal sources;

    function _chain() internal override returns (bool) {
        return _localChain();
    }

    function setUp() public override {
        super.setUp();
        copier = new CopyPrices();
        record.admin = address(kit);
        record.priceWriter = address(copier);
        record.market = d.market;
        vm.startPrank(address(kit));
        market.setOperator(address(copier));
        for (uint256 i; i < d.tokens.length; ++i) {
            TestPriceFeed(d.tokens[i].feed).setWriter(address(copier));
            TestPriceFeed(d.tokens[i].average).setWriter(address(copier));
        }
        vm.stopPrank();
        for (uint256 i; i < d.tokens.length; ++i) {
            TestPriceFeed source = new TestPriceFeed(8, cfg.tokens[i].sourceDescription, address(this), address(0));
            sources.push(source);
            record.assets.push(
                CopyPrices.Asset({
                    symbol: cfg.tokens[i].symbol,
                    token: d.tokens[i].token,
                    feed: d.tokens[i].feed,
                    average: d.tokens[i].average,
                    source: address(source),
                    sourceDescription: cfg.tokens[i].sourceDescription
                })
            );
        }
    }

    /// Every source answers its token's kit price, stamped `at`.
    function _sourcesAt(uint256 at) internal {
        for (uint256 i; i < sources.length; ++i) {
            sources[i].write(cfg.tokens[i].answer, at);
        }
    }

    function _read() internal view returns (CopyPrices.Reading[] memory readings) {
        readings = new CopyPrices.Reading[](record.assets.length);
        for (uint256 i; i < record.assets.length; ++i) {
            readings[i] = copier.readSource(record.assets[i], block.timestamp);
        }
    }

    function _copy() internal returns (CopyPrices.Result memory) {
        return copier.copy(record, _read(), 1000, address(factory));
    }

    function _held(address feed) internal view returns (int256 answer, uint256 at) {
        (, answer,, at,) = TestPriceFeed(feed).latestRoundData();
    }

    // ---- reading

    /// Each round counts for the time it held inside the hour; the latest holds up to the block read.
    function test_copier_averageWeighsEachRoundByTheTimeItHeld() public {
        uint256 t = KIT_TIME + 4000;
        vm.warp(t - 3000);
        sources[0].write(100e8, t - 3000);
        vm.warp(t - 1200);
        sources[0].write(110e8, t - 1200);
        vm.warp(t - 600);
        sources[0].write(120e8, t - 600);
        CopyPrices.Reading memory r = copier.readSource(record.assets[0], t);
        assertEq(r.answer, 120e8);
        assertEq(r.updatedAt, t - 600);
        // 1,800 s at 100, 600 at 110, 600 at 120, over the 3,000 s the feed has rounds for
        assertEq(r.average, 106e8);
        assertEq(r.averageAt, t);
        assertEq(r.covered, 3000, "the feed's rounds start 3,000 s into the hour");
    }

    /// A round from before the hour counts only from the hour's start.
    function test_copier_averageStopsAtTheHour() public {
        uint256 t = KIT_TIME + 8000;
        vm.warp(t - 7200);
        sources[0].write(100e8, t - 7200);
        vm.warp(t - 1800);
        sources[0].write(200e8, t - 1800);
        assertEq(copier.readSource(record.assets[0], t).average, 150e8);
        assertEq(copier.readSource(record.assets[0], t).covered, 1 hours);
    }

    /// No round held for any time inside the window: the average is the answer.
    function test_copier_aRoundJustWritten_isItsOwnAverage() public {
        sources[0].write(123e8, KIT_TIME);
        CopyPrices.Reading memory r = copier.readSource(record.assets[0], KIT_TIME);
        assertEq(r.average, 123e8);
    }

    /// A feed whose description is not the one the record names is not read.
    function test_copier_aSourceThatSaysItIsAnotherFeed_isRefused() public {
        _sourcesAt(KIT_TIME);
        record.assets[0].sourceDescription = "RHAAPL / USD";
        CopyPrices.Reading memory r = copier.readSource(record.assets[0], KIT_TIME);
        assertGt(bytes(r.why).length, 0);
        (int256 before, uint256 beforeAt) = _held(d.tokens[0].feed);
        CopyPrices.Result memory result = _copy();
        assertEq(result.refused, 1);
        (int256 after_, uint256 afterAt) = _held(d.tokens[0].feed);
        assertEq(after_, before);
        assertEq(afterAt, beforeAt);
    }

    // ---- writing

    /// A newer round is written with its own answer and time, the average with the block's time; a second
    /// round of the copier with nothing newer sends nothing.
    function test_copier_writesWhatIsNewer_andASecondRoundNothing() public {
        vm.warp(T0);
        _sourcesAt(T0 - 10);
        CopyPrices.Result memory result = _copy();
        assertEq(result.written, d.tokens.length);
        for (uint256 i; i < d.tokens.length; ++i) {
            (int256 price, uint256 at) = _held(d.tokens[i].feed);
            assertEq(price, cfg.tokens[i].answer);
            assertEq(at, T0 - 10);
            (, uint256 averageAt) = _held(d.tokens[i].average);
            assertEq(averageAt, T0);
        }
        result = _copy();
        assertEq(result.written, 0);
        assertEq(result.unchanged, d.tokens.length);
    }

    /// The average goes with each new round; between rounds it is written at most every five minutes and
    /// only while it moves; once it has caught up, nothing more is written.
    function test_copier_theAverageAtMostEveryFiveMinutes_andOnlyWhileItMoves() public {
        vm.warp(T0);
        _sourcesAt(T0 - 10);
        _copy();
        vm.warp(T0 + 300);
        assertEq(_copy().written, 0, "nothing moved");

        int256 p = cfg.tokens[0].answer;
        vm.warp(T0 + 400);
        sources[0].write(p * 101 / 100, T0 + 400);
        vm.warp(T0 + 450);
        assertEq(_copy().written, 1, "a new round takes its average with it");
        (int256 average, uint256 averageAt) = _held(d.tokens[0].average);
        assertEq(averageAt, T0 + 450);
        assertLt(average, p * 101 / 100, "the average is still catching up");

        vm.warp(T0 + 450 + 299);
        assertEq(_copy().written, 0, "less than five minutes");
        vm.warp(T0 + 450 + 300);
        assertEq(_copy().written, 1, "five minutes, and it moved");
        (int256 later,) = _held(d.tokens[0].average);
        assertGt(later, average);

        vm.warp(T0 + 400 + 2 hours);
        assertEq(_copy().written, 1, "caught up with the round");
        (later,) = _held(d.tokens[0].average);
        assertEq(later, p * 101 / 100);
        vm.warp(T0 + 400 + 3 hours);
        assertEq(_copy().written, 0, "and then stays");
    }

    /// A move of 15% within the hour is refused; after twelve hours it is copied; 60% is refused whatever
    /// the gap, and nothing of a refused token is written.
    function test_copier_aJump_isRefused_andWidensWithTheGap() public {
        uint256 i = 2;
        int256 p = cfg.tokens[i].answer;
        _sourcesAt(KIT_TIME - 10);
        _copy();

        vm.warp(KIT_TIME + 600);
        sources[i].write(p * 115 / 100, KIT_TIME + 600);
        CopyPrices.Result memory result = _copy();
        assertEq(result.refused, 1);
        (int256 held,) = _held(d.tokens[i].feed);
        assertEq(held, p);

        vm.warp(KIT_TIME + 12 hours);
        sources[i].write(p * 160 / 100, KIT_TIME + 12 hours);
        assertEq(copier.readSource(record.assets[i], block.timestamp).answer, p * 160 / 100);
        result = copier.copy(record, _read(), 1000, address(0));
        assertEq(result.refused, 1, "60% is past the 5,000 bps any gap allows");

        vm.warp(KIT_TIME + 12 hours + 1);
        sources[i].write(p * 115 / 100, KIT_TIME + 12 hours + 1);
        result = copier.copy(record, _read(), 1000, address(0));
        assertEq(result.refused, 0, "15% after twelve hours");
        (held,) = _held(d.tokens[i].feed);
        assertEq(held, p * 115 / 100);
    }

    /// A value outside the vault's range for the token is refused, with the factory named.
    function test_copier_outsideTheVaultsRange_isRefused() public {
        uint256 i = 4;
        int256 p = cfg.tokens[i].answer;
        _sourcesAt(KIT_TIME - 10);
        _copy();
        vm.warp(KIT_TIME + 13 hours);
        sources[i].write(p * 130 / 100, KIT_TIME + 12 hours);
        assertEq(_copy().refused, 1, "130% is past the range's top, 125%");
        assertEq(copier.copy(record, _read(), 1000, address(0)).refused, 0, "with no range, the jump rule passes it");
    }

    function test_copier_aValueNotAboveZeroOrStampedAhead_isRefused() public view {
        assertGt(bytes(copier.refusal("price", 0, block.timestamp, 0, 0, 0, 0, 1000)).length, 0);
        assertGt(bytes(copier.refusal("price", 1e8, block.timestamp + 61, 0, 0, 0, 0, 1000)).length, 0);
        assertEq(bytes(copier.refusal("price", 1e8, block.timestamp + 60, 0, 0, 0, 0, 1000)).length, 0);
    }

    /// After a copy that moves the price, each pool goes back to its test price.
    function test_copier_recentresThePools() public {
        vm.warp(KIT_TIME + 60);
        for (uint256 i; i < sources.length; ++i) {
            sources[i].write(cfg.tokens[i].answer * 102 / 100, KIT_TIME + 60);
        }
        CopyPrices.Result memory result = _copy();
        assertEq(result.written, d.tokens.length);
        assertEq(result.recentred, d.tokens.length);
        for (uint256 i; i < d.tokens.length; ++i) {
            assertLe(market.driftOf(d.tokens[i].token), market.driftBps());
        }
        assertEq(_copy().recentred, 0);
    }

    function test_copier_signsOnlyAsThePriceWriter() public {
        vm.expectRevert(abi.encodeWithSelector(CopyPrices.DeployKey.selector, address(kit)));
        copier.checkSigner(record, address(kit));
        vm.expectRevert(abi.encodeWithSelector(CopyPrices.NotTheWriter.selector, stranger, address(copier)));
        copier.checkSigner(record, stranger);
        copier.checkSigner(record, address(copier));
    }

    // ---- the networks it reads and writes

    /// It writes nowhere that is Robinhood Chain's or Base's mainnet.
    function test_copier_refusesToWriteOnAMainnet() public {
        vm.warp(T0);
        _sourcesAt(T0 - 10);
        CopyPrices.Reading[] memory readings = _read();
        uint256[2] memory mainnets = [uint256(4663), 8453];
        for (uint256 i; i < mainnets.length; ++i) {
            vm.chainId(mainnets[i]);
            vm.expectRevert(abi.encodeWithSelector(CopyPrices.MainnetRefused.selector, mainnets[i]));
            copier.copy(record, readings, 1000, address(factory));
        }
    }

    /// It reads from Robinhood Chain mainnet and from nothing else.
    function test_copier_readsOnlyFromRobinhoodMainnet() public {
        copier.checkSource(4663);
        vm.expectRevert(abi.encodeWithSelector(CopyPrices.SourceNotMainnet.selector, 46_630));
        copier.checkSource(46_630);
        vm.expectRevert(abi.encodeWithSelector(CopyPrices.SourceNotMainnet.selector, 8453));
        copier.checkSource(8453);
    }

    /// A source that does not answer refuses its own token and no other.
    function test_copier_aFeedThatDoesNotAnswer_refusesOnlyItsToken() public {
        vm.warp(T0);
        _sourcesAt(T0 - 10);
        // A price contract with no round reverts on `latestRoundData`, as a broken feed would.
        record.assets[3].source =
            address(new TestPriceFeed(8, cfg.tokens[3].sourceDescription, address(this), address(0)));
        CopyPrices.Reading[] memory readings = copier.readAll(record.assets, block.timestamp);
        assertEq(readings[3].why, "the source feed did not answer");
        assertEq(bytes(readings[2].why).length, 0);
        CopyPrices.Result memory result = copier.copy(record, readings, 1000, address(factory));
        assertEq(result.refused, 1);
        assertEq(result.written, d.tokens.length - 1);
    }
}
