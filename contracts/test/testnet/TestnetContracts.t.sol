// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {StubSequencerFeed} from "../../testnet/StubSequencerFeed.sol";
import {TestPriceFeed} from "../../testnet/TestPriceFeed.sol";
import {TestStockToken} from "../../testnet/TestStockToken.sol";
import {TestToken} from "../../testnet/TestToken.sol";

/// The test network's own contracts (TNET-1), each on its own: who may do what, and what they answer.
contract TestnetContractsTest is Test {
    address internal admin = makeAddr("admin");
    address internal minter = makeAddr("minter");
    address internal issuer = makeAddr("issuer");
    address internal writer = makeAddr("writer");
    address internal holder = makeAddr("holder");
    address internal stranger = makeAddr("stranger");

    /// Monday 2026-10-05, 15:00 UTC.
    uint256 internal constant NOW = 1_791_212_400;

    TestToken internal cash;
    TestStockToken internal stock;
    TestPriceFeed internal feed;

    function setUp() public {
        vm.warp(NOW);
        cash = new TestToken("Test USDG", "tUSDG", 6, admin);
        stock = new TestStockToken("Test SPY", "tSPY", 18, admin);
        feed = new TestPriceFeed(8, "tSPY / USD (test network)", admin, writer);
        vm.startPrank(admin);
        cash.grantRole(cash.MINTER_ROLE(), minter);
        stock.grantRole(stock.MINTER_ROLE(), minter);
        stock.grantRole(stock.ISSUER_ROLE(), issuer);
        vm.stopPrank();
    }

    function _denied(address who, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, who, role);
    }

    // ---- test cash and the token base

    function test_cash_hasItsDecimals_andOnlyAMinterMints() public {
        assertEq(cash.decimals(), 6);
        assertEq(cash.symbol(), "tUSDG");
        vm.prank(minter);
        cash.mint(holder, 100e6);
        assertEq(cash.balanceOf(holder), 100e6);

        bytes32 role = cash.MINTER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(_denied(stranger, role));
        cash.mint(stranger, 1);
        vm.prank(admin);
        vm.expectRevert(_denied(admin, role));
        cash.mint(admin, 1);
    }

    function test_cash_onlyAMinterBurns() public {
        vm.prank(minter);
        cash.mint(holder, 100e6);
        bytes32 role = cash.MINTER_ROLE();
        vm.prank(holder);
        vm.expectRevert(_denied(holder, role));
        cash.burn(holder, 1);
        vm.prank(minter);
        cash.burn(holder, 40e6);
        assertEq(cash.balanceOf(holder), 60e6);
        assertEq(cash.totalSupply(), 60e6);
    }

    function test_cash_onlyTheAdminGivesARole() public {
        bytes32 role = cash.MINTER_ROLE();
        bytes32 adminRole = cash.DEFAULT_ADMIN_ROLE();
        vm.prank(minter);
        vm.expectRevert(_denied(minter, adminRole));
        cash.grantRole(role, stranger);
    }

    /// The token leaves Permit2's allowance to the holder: none until the holder gives one.
    function test_cash_givesPermit2NothingByDefault() public view {
        assertEq(cash.allowance(holder, 0x000000000022D473030F116dDEE9F6B43aC78BA3), 0);
        assertEq(stock.allowance(holder, 0x000000000022D473030F116dDEE9F6B43aC78BA3), 0);
    }

    // ---- the test stock token: the calls the vault probes

    function test_stock_answersAsARealStockTokenBeforeAnyChange() public view {
        assertEq(stock.decimals(), 18);
        assertEq(stock.uiMultiplier(), 1e18);
        assertEq(stock.newUIMultiplier(), 1e18);
        assertEq(stock.effectiveAt(), 0);
        assertFalse(stock.paused());
        assertFalse(stock.tokenPaused());
    }

    /// The vault's probes go by selector, without an interface: these are the words its config holds.
    function test_stock_answersTheVaultsSelectors() public {
        vm.prank(issuer);
        stock.updateMultiplier(1.01e18, NOW + 3 days);
        (bool ok, bytes memory ret) = address(stock).staticcall(abi.encodeWithSelector(bytes4(0x97a4064f)));
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint256)), NOW + 3 days, "effectiveAt()");
        (ok, ret) = address(stock).staticcall(abi.encodeWithSelector(bytes4(0x5c975abb)));
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint256)), 0, "paused()");
        vm.prank(issuer);
        stock.pause();
        (ok, ret) = address(stock).staticcall(abi.encodeWithSelector(bytes4(0x5c975abb)));
        assertEq(abi.decode(ret, (uint256)), 1, "paused() while paused");
    }

    /// A change set for later: the old multiplier until then, the new one from then on.
    function test_stock_aScheduledMultiplier_takesEffectAtItsTime() public {
        vm.prank(minter);
        stock.mint(holder, 10e18);
        vm.prank(issuer);
        stock.updateMultiplier(1.5e18, NOW + 1 days);
        assertEq(stock.uiMultiplier(), 1e18);
        assertEq(stock.newUIMultiplier(), 1.5e18);
        assertEq(stock.effectiveAt(), NOW + 1 days);
        assertEq(stock.balanceOfUI(holder), 10e18);

        vm.warp(NOW + 1 days - 1);
        assertEq(stock.uiMultiplier(), 1e18);
        vm.warp(NOW + 1 days);
        assertEq(stock.uiMultiplier(), 1.5e18);
        assertEq(stock.balanceOfUI(holder), 15e18);
        assertEq(stock.totalSupplyUI(), 15e18);
        assertEq(stock.balanceOf(holder), 10e18, "raw balances do not move");
    }

    /// A change now, then another for later: the second starts from the one in effect.
    function test_stock_aChangeNow_thenAnotherLater() public {
        vm.startPrank(issuer);
        stock.updateMultiplier(1.2e18);
        assertEq(stock.uiMultiplier(), 1.2e18);
        assertEq(stock.effectiveAt(), NOW);
        stock.updateMultiplier(2e18, NOW + 10 days);
        vm.stopPrank();
        assertEq(stock.uiMultiplier(), 1.2e18);
        vm.warp(NOW + 10 days);
        assertEq(stock.uiMultiplier(), 2e18);
    }

    /// A change still to come is replaced, not stacked.
    function test_stock_aSecondScheduleReplacesTheFirst() public {
        vm.startPrank(issuer);
        stock.updateMultiplier(1.5e18, NOW + 1 days);
        stock.updateMultiplier(3e18, NOW + 2 days);
        vm.stopPrank();
        vm.warp(NOW + 1 days);
        assertEq(stock.uiMultiplier(), 1e18);
        vm.warp(NOW + 2 days);
        assertEq(stock.uiMultiplier(), 3e18);
    }

    function test_stock_aMultiplierOfZero_orInThePast_isRefused() public {
        vm.startPrank(issuer);
        vm.expectRevert(TestStockToken.ZeroMultiplier.selector);
        stock.updateMultiplier(0);
        vm.expectRevert(abi.encodeWithSelector(TestStockToken.EffectiveInThePast.selector, NOW - 1, NOW));
        stock.updateMultiplier(1e18, NOW - 1);
        vm.stopPrank();
    }

    function test_stock_onlyTheIssuerPausesAndSetsTheMultiplier() public {
        bytes32 role = stock.ISSUER_ROLE();
        vm.startPrank(minter);
        vm.expectRevert(_denied(minter, role));
        stock.pause();
        vm.expectRevert(_denied(minter, role));
        stock.unpause();
        vm.expectRevert(_denied(minter, role));
        stock.updateMultiplier(2e18);
        vm.expectRevert(_denied(minter, role));
        stock.updateMultiplier(2e18, NOW + 1 days);
        vm.stopPrank();
    }

    /// A paused token moves nothing: no transfer, no pull, no mint, no burn. Unpaused, it moves again.
    function test_stock_paused_movesNothing() public {
        vm.prank(minter);
        stock.mint(holder, 10e18);
        vm.prank(holder);
        stock.approve(stranger, 10e18);
        vm.prank(issuer);
        stock.pause();
        assertTrue(stock.paused());

        vm.prank(holder);
        vm.expectRevert(TestStockToken.TokenPaused.selector);
        stock.transfer(stranger, 1);
        vm.prank(stranger);
        vm.expectRevert(TestStockToken.TokenPaused.selector);
        stock.transferFrom(holder, stranger, 1);
        vm.startPrank(minter);
        vm.expectRevert(TestStockToken.TokenPaused.selector);
        stock.mint(holder, 1);
        vm.expectRevert(TestStockToken.TokenPaused.selector);
        stock.burn(holder, 1);
        vm.stopPrank();

        vm.prank(issuer);
        stock.unpause();
        vm.prank(holder);
        stock.transfer(stranger, 1);
        assertEq(stock.balanceOf(stranger), 1);
    }

    // ---- the price contract

    function test_feed_answersAsAChainlinkAggregator() public {
        assertEq(feed.decimals(), 8);
        assertEq(feed.description(), "tSPY / USD (test network)");
        assertEq(feed.version(), 1);
        vm.prank(writer);
        feed.write(776_80000000, NOW - 120);
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            feed.latestRoundData();
        assertEq(roundId, 1);
        assertEq(answer, 776_80000000);
        assertEq(startedAt, NOW - 120);
        assertEq(updatedAt, NOW - 120);
        assertEq(answeredInRound, 1);
    }

    /// Before its first round a feed has nothing to say, as a new aggregator does; so the vault reads no price.
    function test_feed_beforeTheFirstRound_reverts() public {
        vm.expectRevert(TestPriceFeed.NoDataPresent.selector);
        feed.latestRoundData();
        vm.expectRevert(TestPriceFeed.NoDataPresent.selector);
        feed.getRoundData(1);
    }

    /// Every round stays readable by its id, as the copier's average needs on the source and a reader may
    /// want here.
    function test_feed_keepsEachRound() public {
        vm.startPrank(writer);
        feed.write(100e8, NOW - 300);
        feed.write(101e8, NOW - 200);
        feed.write(102e8, NOW - 100);
        vm.stopPrank();
        (uint80 id, int256 answer,, uint256 updatedAt,) = feed.getRoundData(2);
        assertEq(id, 2);
        assertEq(answer, 101e8);
        assertEq(updatedAt, NOW - 200);
        assertEq(feed.latestRound(), 3);
        vm.expectRevert(TestPriceFeed.NoDataPresent.selector);
        feed.getRoundData(4);
    }

    function test_feed_onlyTheWriterOrTheOwnerWrites() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(TestPriceFeed.NotWriter.selector, stranger));
        feed.write(100e8, NOW);
        vm.prank(admin);
        feed.write(100e8, NOW - 10);
        vm.prank(writer);
        feed.write(101e8, NOW);
        assertEq(feed.latestRound(), 2);
    }

    /// The owner names a new writer; the old one can write no more.
    function test_feed_theOwnerReplacesTheWriter() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        feed.setWriter(stranger);
        vm.prank(admin);
        feed.setWriter(stranger);
        assertEq(feed.writer(), stranger);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(TestPriceFeed.NotWriter.selector, writer));
        feed.write(100e8, NOW);
        vm.prank(stranger);
        feed.write(100e8, NOW);
    }

    function test_feed_anAnswerOfZeroOrBelow_isRefused() public {
        vm.startPrank(writer);
        vm.expectRevert(abi.encodeWithSelector(TestPriceFeed.AnswerNotPositive.selector, int256(0)));
        feed.write(0, NOW);
        vm.expectRevert(abi.encodeWithSelector(TestPriceFeed.AnswerNotPositive.selector, int256(-1)));
        feed.write(-1, NOW);
        vm.stopPrank();
    }

    /// A round is never replaced by one of the same time or older: the copier writes only what is newer.
    function test_feed_aTimeNotNewer_isRefused() public {
        vm.startPrank(writer);
        feed.write(100e8, NOW - 100);
        vm.expectRevert(abi.encodeWithSelector(TestPriceFeed.NotNewer.selector, NOW - 100, NOW - 100));
        feed.write(101e8, NOW - 100);
        vm.expectRevert(abi.encodeWithSelector(TestPriceFeed.NotNewer.selector, NOW - 101, NOW - 100));
        feed.write(101e8, NOW - 101);
        feed.write(101e8, NOW - 99);
        vm.stopPrank();
    }

    /// At most a minute ahead of the chain's clock.
    function test_feed_aTimeTooFarAhead_isRefused() public {
        vm.startPrank(writer);
        vm.expectRevert(abi.encodeWithSelector(TestPriceFeed.StampedAhead.selector, NOW + 61, NOW));
        feed.write(100e8, NOW + 61);
        feed.write(100e8, NOW + 60);
        vm.stopPrank();
    }

    /// The owner is handed over in two steps.
    function test_feed_theOwnerIsHandedOverInTwoSteps() public {
        vm.prank(admin);
        feed.transferOwnership(stranger);
        assertEq(feed.owner(), admin);
        vm.prank(stranger);
        feed.acceptOwnership();
        assertEq(feed.owner(), stranger);
    }

    // ---- the sequencer stub

    function test_sequencer_answersUp_sinceItsTime() public {
        StubSequencerFeed seq = new StubSequencerFeed(admin, NOW - 2 hours);
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt,) = seq.latestRoundData();
        assertEq(roundId, 1);
        assertEq(answer, 0);
        assertEq(startedAt, NOW - 2 hours);
        assertEq(updatedAt, NOW - 2 hours);
        StubSequencerFeed fresh = new StubSequencerFeed(admin, 0);
        (,, startedAt,,) = fresh.latestRoundData();
        assertEq(startedAt, NOW);
    }

    function test_sequencer_aTimeAhead_isRefused() public {
        vm.expectRevert(abi.encodeWithSelector(StubSequencerFeed.ChangedInTheFuture.selector, NOW + 1, NOW));
        new StubSequencerFeed(admin, NOW + 1);
    }

    /// Down is 1, up again is 0, each from the time it changed; the same status twice starts no round.
    function test_sequencer_downAndUp() public {
        StubSequencerFeed seq = new StubSequencerFeed(admin, NOW - 2 hours);
        vm.prank(admin);
        seq.setDown(true);
        (uint80 roundId, int256 answer, uint256 startedAt,,) = seq.latestRoundData();
        assertEq(roundId, 2);
        assertEq(answer, 1);
        assertEq(startedAt, NOW);
        vm.warp(NOW + 600);
        vm.prank(admin);
        seq.setDown(true);
        (roundId,, startedAt,,) = seq.latestRoundData();
        assertEq(roundId, 2);
        assertEq(startedAt, NOW);
        vm.prank(admin);
        seq.setDown(false);
        (roundId, answer, startedAt,,) = seq.latestRoundData();
        assertEq(roundId, 3);
        assertEq(answer, 0);
        assertEq(startedAt, NOW + 600);
    }

    function test_sequencer_onlyTheOwnerFlipsIt() public {
        StubSequencerFeed seq = new StubSequencerFeed(admin, 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        seq.setDown(true);
    }
}
