// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {AssetConfig, Swap} from "../src/interfaces/Types.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {KeeperFixture} from "./helpers/KeeperFixture.sol";
import {MockFeed} from "./mocks/Feeds.sol";
import {MockRouter} from "./mocks/Routers.sol";
import {BackdoorToken} from "./mocks/Tokens.sol";

/// A stolen keeper key with a router that pays whatever it likes: more than the price, less, nothing, to
/// someone else, or while taking another target out of the vault. The prices stay where they are, so every
/// loss the vault takes is a loss at the reference price.
contract KeeperHandler is Test {
    uint256 internal constant BPS = 10_000;

    BasketVault internal vault;
    address internal keeper;
    address internal attacker;
    BackdoorToken internal cash;
    BackdoorToken[2] internal assets;
    uint16[2] internal targets;
    uint256[2] internal prices;
    MockFeed[4] internal feeds;
    MockRouter internal router;
    uint256 internal unit;
    uint256 internal end;

    uint256 public trades;
    uint256 public refused;
    /// Set if a trade the vault took left its asset further from the target than it began, or crossed it
    /// and ended more than half as far on the other side (I5).
    bool public widened;

    constructor(
        BasketVault vault_,
        address keeper_,
        address attacker_,
        BackdoorToken cash_,
        BackdoorToken[2] memory assets_,
        uint16[2] memory targets_,
        uint256[2] memory prices_,
        MockFeed[4] memory feeds_,
        MockRouter router_,
        uint256 unit_
    ) {
        vault = vault_;
        keeper = keeper_;
        attacker = attacker_;
        cash = cash_;
        assets = assets_;
        targets = targets_;
        prices = prices_;
        feeds = feeds_;
        router = router_;
        unit = unit_;
        end = block.timestamp + 7 days;
    }

    /// What the vault is worth at the feeds' prices, cash at $1, in raw units of cash.
    function value() public view returns (uint256 total) {
        total = cash.balanceOf(address(vault));
        for (uint256 i; i < 2; ++i) {
            total += _valueOf(i, assets[i].balanceOf(address(vault)));
        }
    }

    function _valueOf(uint256 i, uint256 amount) internal view returns (uint256) {
        return amount * prices[i] * 1e6 / (1e8 * unit);
    }

    /// `|weight - target|` in units of `value * 10^4`, and the vault's value.
    function _distance(uint256 i) internal view returns (uint256 off, uint256 total, bool over) {
        total = value();
        uint256 weight = _valueOf(i, assets[i].balanceOf(address(vault))) * BPS;
        uint256 target = total * targets[i];
        over = weight > target;
        off = over ? weight - target : target - weight;
    }

    /// One keeper trade of either asset, either way, of any size, at a price `swingBps` from the feed's
    /// (negative: the router pays more than the price), in one of four ways a router can behave.
    function trade(uint256 assetSeed, bool buying, uint256 amount, int256 swingBps, uint256 mode) external {
        uint256 i = assetSeed % 2;
        address asset = address(assets[i]);
        swingBps = bound(swingBps, -200, 2000);
        uint256 out;
        Swap memory s;
        if (buying) {
            amount = bound(amount, 1, cash.balanceOf(address(vault)) / 2 + 1);
            out = amount * 1e8 * unit / (prices[i] * 1e6);
            s = Swap(address(router), address(cash), asset, amount, 0, "");
        } else {
            amount = bound(amount, 1, assets[i].balanceOf(address(vault)) + 1);
            out = _valueOf(i, amount);
            s = Swap(address(router), asset, address(cash), amount, 0, "");
        }
        out = uint256(int256(out) * (int256(BPS) - swingBps) / int256(BPS));
        mode = mode % 4;
        if (mode == 0) {
            s.data = abi.encodeCall(MockRouter.swap, (s.tokenIn, s.tokenOut, amount, out));
        } else if (mode == 1) {
            s.data = abi.encodeCall(MockRouter.swapTo, (s.tokenIn, s.tokenOut, amount, out, attacker));
        } else if (mode == 2) {
            address other = address(assets[1 - i]);
            uint256 held = assets[1 - i].balanceOf(address(vault));
            s.data = abi.encodeCall(MockRouter.swapAndSeize, (s.tokenIn, s.tokenOut, amount, out, other, held / 2 + 1));
        } else {
            // Spends more than it was given, through a token's back door.
            s.data = abi.encodeCall(
                MockRouter.swapAndSeize, (s.tokenIn, s.tokenOut, amount, out, s.tokenIn, amount / 10 + 1)
            );
        }

        (uint256 offBefore, uint256 valueBefore, bool overBefore) = _distance(i);
        vm.prank(keeper);
        try vault.keeperSwap(s) {
            ++trades;
            (uint256 offAfter, uint256 valueAfter, bool overAfter) = _distance(i);
            // The vault's own rule, worked out again from the balances: no further, and half as far if it
            // crossed. An asset at its target after the trade has not crossed.
            bool crossed = offAfter != 0 && overBefore != overAfter;
            if (offAfter * valueBefore * (crossed ? 2 : 1) > offBefore * valueAfter) widened = true;
        } catch {
            ++refused;
        }
    }

    /// Time passes, inside the seven days the bound speaks of, and the feeds write the same prices again.
    function wait(uint256 seconds_) external {
        seconds_ = bound(seconds_, 0, 12 hours);
        if (block.timestamp + seconds_ > end) seconds_ = end - block.timestamp;
        vm.warp(block.timestamp + seconds_);
        for (uint256 i; i < feeds.length; ++i) {
            (, int256 answer,,,) = feeds[i].latestRoundData();
            feeds[i].set(answer, block.timestamp);
        }
    }
}

contract KeeperInvariantTest is KeeperFixture {
    KeeperHandler internal handler;
    address internal attacker = makeAddr("attacker");
    uint256 internal startValue;

    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function setUp() public {
        _deployKeeperPlatform();
        // Both assets trade at all hours, so the seven days are all open.
        AssetConfig memory a = _keeperAsset(feedA, averageA, PRICE_A, 0);
        AssetConfig memory b = _keeperAsset(feedB, averageB, PRICE_B, 0);
        vm.startPrank(admin);
        factory.setAsset(address(stockA), a);
        factory.setAsset(address(stockB), b);
        vm.stopPrank();
        handler = new KeeperHandler(
            vault,
            keeper,
            attacker,
            cash,
            [stockA, stockB],
            [TARGET_A, TARGET_B],
            [PRICE_A, PRICE_B],
            [feedA, averageA, feedB, averageB],
            direct,
            unit
        );
        startValue = handler.value();
        targetContract(address(handler));
    }

    /// I2: whatever a hostile keeper does in seven days, the vault is worth at least 98% of what it started
    /// with at the reference prices: twice the weekly cap of 100 bps, the most a counter that drains as it
    /// fills lets through. With no owner flows there is nothing to net out.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_I2_aHostileKeeperLosesAtMostTwiceTheCapInSevenDays() public view {
        (, uint16 lossCap,,,,) = factory.params();
        assertGe(handler.value() * BPS, startValue * (BPS - 2 * uint256(lossCap)));
    }

    /// I5: no trade the vault took left its asset further from the target.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_I5_aKeeperTradeNeverWidensTheDistance() public view {
        assertFalse(handler.widened());
    }

    /// A1 and I1: nothing reaches the keeper or anyone the router names.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_A1_nothingLeavesForTheKeeperOrTheAttacker() public view {
        assertEq(cash.balanceOf(keeper) + stockA.balanceOf(keeper) + stockB.balanceOf(keeper), 0);
        assertEq(cash.balanceOf(attacker) + stockA.balanceOf(attacker) + stockB.balanceOf(attacker), 0);
    }

    /// The handler's trades do go through when they keep to the rules: a run is not all refusals.
    function test_handler_anHonestTradeGoesThrough() public {
        handler.trade(0, true, 4000 * USD - 1, 0, 0);
        assertEq(handler.trades(), 1);
        assertEq(handler.refused(), 0);
        handler.trade(1, true, 3000 * USD - 1, 100, 0);
        assertEq(handler.trades(), 2);
        handler.trade(1, false, 1, 0, 1);
        assertEq(handler.refused(), 1);
    }
}
