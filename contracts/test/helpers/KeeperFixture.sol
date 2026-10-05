// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {AssetConfig, Params, Swap} from "../../src/interfaces/Types.sol";
import {MockFeed} from "../mocks/Feeds.sol";
import {MockRouter} from "../mocks/Routers.sol";
import {BackdoorToken} from "../mocks/Tokens.sol";
import {SwapFixture} from "./SwapFixture.sol";

/// The platform as the keeper sees it: each stock token with a Chainlink-style feed, its one-hour average as
/// a second feed, a price range and the keeper's switch on; the keeper's limits of section 5 (125 bps a
/// trade, 100 bps a week, a 50 bps band, an hour between trades in one asset, 200 bps between a price and its
/// average); and one vault of $10,000 in cash with targets of 40% in stock A and 30% in stock B, auto-follow
/// on. Stock A and B trade in US hours; stock C at all hours, as gold does.
///
/// The clock starts on Monday 2026-10-05 at 15:00 UTC, inside the session.
abstract contract KeeperFixture is SwapFixture {
    uint256 internal constant MONDAY_1500 = 1_791_212_400;
    uint256 internal constant START = 10_000 * USD;
    uint256 internal constant BPS = 10_000;
    /// Dollars for one whole token, in the feeds' 8 decimals.
    uint256 internal constant PRICE_A = 100e8;
    uint256 internal constant PRICE_B = 50e8;
    uint256 internal constant PRICE_C = 20e8;
    uint16 internal constant TARGET_A = 4000;
    uint16 internal constant TARGET_B = 3000;

    MockFeed internal feedA;
    MockFeed internal averageA;
    MockFeed internal feedB;
    MockFeed internal averageB;
    MockFeed internal feedC;
    MockFeed internal averageC;

    function _deployKeeperPlatform() internal {
        _deploySwapPlatform();
        vm.warp(MONDAY_1500);
        (feedA, averageA) = _priced(stockA, PRICE_A, 1);
        (feedB, averageB) = _priced(stockB, PRICE_B, 1);
        (feedC, averageC) = _priced(stockC, PRICE_C, 0);
        vm.startPrank(admin);
        factory.setParams(_keeperParams());
        factory.setPriceDevBps(200);
        vm.stopPrank();

        vm.startPrank(owner);
        vault.deposit(START);
        vault.setTargets(_targets(address(stockA), TARGET_A, address(stockB), TARGET_B));
        vault.setAutoFollow(true);
        vm.stopPrank();
    }

    /// The design's starting values on Solana, which the EVM keeper holds too: 125 bps a trade, 100 bps a
    /// week (a person is told 2%), a 50 bps band, an hour, Monday to Friday 14:30 to 20:00 UTC.
    function _keeperParams() internal pure returns (Params memory) {
        return Params({
            toleranceBps: 125,
            lossCapBps: 100,
            bandBps: 50,
            assetCooldown: 3600,
            sessionOpen: 52_200,
            sessionClose: 72_000
        });
    }

    /// Lists `token` with a feed and an average at `price`, written now, a range of three quarters of the
    /// price to one and a half times it, and the keeper's switch on.
    function _priced(BackdoorToken token, uint256 price, uint8 session)
        internal
        returns (MockFeed feed_, MockFeed average)
    {
        feed_ = new MockFeed();
        average = new MockFeed();
        feed_.set(int256(price), block.timestamp);
        average.set(int256(price), block.timestamp);
        vm.prank(admin);
        factory.setAsset(address(token), _keeperAsset(feed_, average, price, session));
    }

    function _keeperAsset(MockFeed feed_, MockFeed average, uint256 price, uint8 session)
        internal
        view
        returns (AssetConfig memory)
    {
        return AssetConfig({
            feed: address(feed_),
            tokenDecimals: dec,
            feedDecimals: 8,
            maxAge: 26 hours,
            session: session,
            source: 1,
            maxWeightBps: 5000,
            pauseProbe: address(0),
            pauseSelector: bytes4(0),
            scheduleSelector: bytes4(0),
            haltUntil: 0,
            flags: 1,
            averageFeed: address(average),
            minPrice: uint128(price * 3 / 4),
            maxPrice: uint128(price * 3 / 2)
        });
    }

    /// Writes every feed again, at the prices they hold, with the time now.
    function _refresh() internal {
        MockFeed[6] memory feeds = [feedA, averageA, feedB, averageB, feedC, averageC];
        for (uint256 i; i < feeds.length; ++i) {
            (, int256 answer,,,) = feeds[i].latestRoundData();
            feeds[i].set(answer, block.timestamp);
        }
    }

    /// The price a feed holds for `token`, in 8 decimals.
    function _priceOf(address token) internal view returns (uint256) {
        MockFeed f = token == address(stockA) ? feedA : token == address(stockB) ? feedB : feedC;
        (, int256 answer,,,) = f.latestRoundData();
        return uint256(answer);
    }

    /// What `amount` of `token` is worth in raw units of cash at its feed, rounded down: the vault's rule.
    function _valueOf(address token, uint256 amount) internal view returns (uint256) {
        if (token == address(cash)) return amount;
        return amount * _priceOf(token) * USD / (1e8 * unit);
    }

    /// How much of `token` is worth `cashAmount` at its feed, rounded down.
    function _amountFor(address token, uint256 cashAmount) internal view returns (uint256) {
        return cashAmount * 1e8 * unit / (_priceOf(token) * USD);
    }

    /// A buy of `token` for `cashAmount`, through `router`, paying `lossBps` less than the feed's price.
    function _buy(MockRouter router, address token, uint256 cashAmount, uint256 lossBps)
        internal
        view
        returns (Swap memory)
    {
        uint256 out = _amountFor(token, cashAmount) * (BPS - lossBps) / BPS;
        return _swap(router, address(cash), token, cashAmount, out);
    }

    /// A sale of `amount` of `token` for cash through `router`, paying `lossBps` less than the feed's price.
    function _sell(MockRouter router, address token, uint256 amount, uint256 lossBps)
        internal
        view
        returns (Swap memory)
    {
        uint256 out = _valueOf(token, amount) * (BPS - lossBps) / BPS;
        return _swap(router, token, address(cash), amount, out);
    }

    function _keeperSwap(Swap memory s) internal returns (uint256 spent, uint256 received) {
        vm.prank(keeper);
        return vault.keeperSwap(s);
    }

    function _expectKeeperRevert(Swap memory s, bytes memory err) internal {
        vm.prank(keeper);
        vm.expectRevert(err);
        vault.keeperSwap(s);
    }

    /// What the vault is worth at the feeds, cash at $1: the targets and the cash.
    function _vaultValue() internal view returns (uint256) {
        return cash.balanceOf(address(vault)) + _valueOf(address(stockA), stockA.balanceOf(address(vault)))
            + _valueOf(address(stockB), stockB.balanceOf(address(vault)))
            + _valueOf(address(stockC), stockC.balanceOf(address(vault)));
    }

    /// The asset's weight in the vault, in bps of its value, rounded down.
    function _weightOf(address token) internal view returns (uint256) {
        return _valueOf(token, BackdoorToken(token).balanceOf(address(vault))) * BPS / _vaultValue();
    }
}
