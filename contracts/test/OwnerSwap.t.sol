// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {IBasketVault} from "../src/interfaces/IBasketVault.sol";
import {IVaultConfig} from "../src/interfaces/IVaultConfig.sol";
import {Swap, Weight} from "../src/interfaces/Types.sol";
import {SwapFixture} from "./helpers/SwapFixture.sol";
import {GreedyPermit2, MockRouter, Permit2Witness, StickyPermit2} from "./mocks/Routers.sol";
import {
    BackdoorToken,
    BrickableBackdoorToken,
    FreezableToken,
    MockToken,
    PermissiveToken,
    StickyToken
} from "./mocks/Tokens.sol";

/// The owner's swap. The vault judges what its own balances did and never what the router says, so most of
/// this file is a router trying each way to cheat. Every test runs with the stock tokens at 6, 8 and 18
/// decimals; the cash token has 6.
abstract contract OwnerSwapTest is SwapFixture {
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        _deploySwapPlatform();
        vm.prank(owner);
        vault.deposit(1000 * USD);
    }

    function _run(Swap memory s) internal {
        vm.prank(owner);
        vault.ownerSwap(_swaps(s), LATER);
    }

    function _expectRevert(Swap memory s, bytes memory err) internal {
        vm.prank(owner);
        vm.expectRevert(err);
        vault.ownerSwap(_swaps(s), LATER);
    }

    /// Nothing moved and nothing is approved: what a refused swap must leave.
    function _assertUntouched() internal view {
        assertEq(cash.balanceOf(address(vault)), 1000 * USD);
        assertEq(stockA.balanceOf(address(vault)), 0);
        _assertNoAllowance(address(vault), address(cash), address(direct));
        _assertNoAllowance(address(vault), address(cash), address(viaPermit2));
        assertEq(cash.allowance(address(vault), attacker), 0);
    }

    // ---- an honest router, pulling each way

    function test_ownerSwap_direct_buysAndTracksTheOutput() public {
        vm.expectEmit(address(vault));
        emit IBasketVault.OwnerTrade(address(vault), address(cash), address(stockA), 600 * USD, 3 * unit);
        _run(_swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit));

        assertEq(cash.balanceOf(address(vault)), 400 * USD);
        assertEq(stockA.balanceOf(address(vault)), 3 * unit);
        address[] memory tracked = vault.tokens();
        assertEq(tracked.length, 2);
        assertEq(tracked[1], address(stockA));
        _assertNoAllowance(address(vault), address(cash), address(direct));
    }

    function test_ownerSwap_permit2_buysAndTracksTheOutput() public {
        vm.expectEmit(address(vault));
        emit IBasketVault.OwnerTrade(address(vault), address(cash), address(stockA), 600 * USD, 3 * unit);
        _run(_swap(viaPermit2, address(cash), address(stockA), 600 * USD, 3 * unit));

        assertEq(cash.balanceOf(address(vault)), 400 * USD);
        assertEq(stockA.balanceOf(address(vault)), 3 * unit);
        assertEq(vault.tokens().length, 2);
        _assertNoAllowance(address(vault), address(cash), address(viaPermit2));
    }

    /// A trade signed and not sent in time is not sent late: after its deadline it is refused, and so is a
    /// batch that carries it. At the deadline itself it goes.
    function test_ownerSwap_isRefusedAfterItsDeadline() public {
        uint64 deadline = uint64(block.timestamp + 60);
        Swap[] memory buy = _swaps(_swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit));
        vm.warp(deadline + 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.DeadlinePassed.selector, deadline, deadline + 1));
        vault.ownerSwap(buy, deadline);

        bytes[] memory batch = new bytes[](2);
        batch[0] = abi.encodeCall(BasketVault.deposit, (100 * USD));
        batch[1] = abi.encodeCall(BasketVault.ownerSwap, (buy, deadline));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.DeadlinePassed.selector, deadline, deadline + 1));
        vault.multicall(batch);
        _assertUntouched();

        vm.warp(deadline);
        vm.prank(owner);
        vault.ownerSwap(buy, deadline);
        assertEq(stockA.balanceOf(address(vault)), 3 * unit);
    }

    /// The way a router pulls is the config's word, not the caller's: a router listed as direct gets no
    /// Permit2 allowance, and its pull through Permit2 fails.
    function test_ownerSwap_pullModeIsTheConfigs() public {
        vm.prank(admin);
        factory.setRouter(address(viaPermit2), 1);
        Swap memory s = _swap(viaPermit2, address(cash), address(stockA), 600 * USD, 3 * unit);
        _expectRevert(
            s,
            abi.encodeWithSelector(
                IBasketVault.RouterFailed.selector,
                address(viaPermit2),
                abi.encodePacked(MockRouter.PullFailed.selector)
            )
        );
        _assertUntouched();
    }

    function test_ownerSwap_sellsBackToCash() public {
        _run(_swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit));
        _run(_swap(viaPermit2, address(stockA), address(cash), 2 * unit, 390 * USD));

        assertEq(stockA.balanceOf(address(vault)), unit);
        assertEq(cash.balanceOf(address(vault)), 790 * USD);
        _assertNoAllowance(address(vault), address(stockA), address(viaPermit2));
    }

    /// A batch runs in order, each swap seeing what the one before left. All pass or none does.
    function test_ownerSwap_batch_runsInOrderOrNotAtAll() public {
        Swap[] memory swaps = new Swap[](3);
        swaps[0] = _swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit);
        swaps[1] = _swap(viaPermit2, address(stockA), address(stockB), unit, 2 * unit);
        swaps[2] = _swap(direct, address(cash), address(stockC), 100 * USD, 5 * unit);

        // The last minimum is one unit too high: the first two are undone with it.
        swaps[2].minOut = 5 * unit + 1;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IBasketVault.ReceivedTooLittle.selector, address(stockC), 5 * unit, 5 * unit + 1)
        );
        vault.ownerSwap(swaps, LATER);
        _assertUntouched();
        assertEq(vault.tokens().length, 1);

        swaps[2].minOut = 5 * unit;
        vm.prank(owner);
        vault.ownerSwap(swaps, LATER);
        assertEq(cash.balanceOf(address(vault)), 300 * USD);
        assertEq(stockA.balanceOf(address(vault)), 2 * unit);
        assertEq(stockB.balanceOf(address(vault)), 2 * unit);
        assertEq(stockC.balanceOf(address(vault)), 5 * unit);
        assertEq(vault.tokens().length, 4);
        _assertNoAllowance(address(vault), address(stockA), address(viaPermit2));
    }

    function test_ownerSwap_anEmptyBatchDoesNothing() public {
        vm.prank(owner);
        vault.ownerSwap(new Swap[](0), LATER);
        _assertUntouched();
    }

    // ---- who may call, and through what

    function test_ownerSwap_revertsForAnyoneButTheOwner() public {
        Swap[] memory swaps = _swaps(_swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit));
        address[6] memory callers = [stranger, admin, guardian, keeper, address(factory), address(direct)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, callers[i]));
            vault.ownerSwap(swaps, LATER);
        }
        _assertUntouched();
    }

    function test_ownerSwap_revertsOnARouterThatIsNotAllowed() public {
        MockRouter unknown = new MockRouter(false);
        stockA.mint(address(unknown), 10 * unit);
        Swap memory s = _swap(unknown, address(cash), address(stockA), 600 * USD, 3 * unit);
        _expectRevert(s, abi.encodeWithSelector(IBasketVault.RouterNotAllowed.selector, address(unknown)));

        // And one the admin took off the list.
        vm.prank(admin);
        factory.setRouter(address(direct), 0);
        s = _swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit);
        _expectRevert(s, abi.encodeWithSelector(IBasketVault.RouterNotAllowed.selector, address(direct)));
        _assertUntouched();
    }

    /// The input must be a token the platform lists or once listed. A token that was only ever sent in from
    /// outside is not traded; the owner withdraws it.
    function test_ownerSwap_revertsOnAnInputThatWasNeverListed() public {
        BackdoorToken stray = new BackdoorToken(dec);
        stray.mint(address(vault), 10 * unit);
        Swap memory s = _swap(direct, address(stray), address(cash), unit, 1);
        _expectRevert(s, abi.encodeWithSelector(IBasketVault.TokenNotAccepted.selector, address(stray)));
        assertEq(stray.balanceOf(address(vault)), 10 * unit);
        assertEq(stray.allowance(address(vault), address(direct)), 0);
    }

    function test_ownerSwap_revertsOnAnOutputThatIsNotListed() public {
        BackdoorToken stray = new BackdoorToken(dec);
        stray.mint(address(direct), 10 * unit);
        Swap memory s = _swap(direct, address(cash), address(stray), 600 * USD, unit);
        _expectRevert(s, abi.encodeWithSelector(IBasketVault.TokenNotAccepted.selector, address(stray)));

        s = _swap(direct, address(cash), address(cash), 600 * USD, 1);
        _expectRevert(s, abi.encodeWithSelector(IBasketVault.TokenNotAccepted.selector, address(cash)));
        _assertUntouched();
    }

    /// An asset the admin took off the list can be sold and withdrawn, and not bought.
    function test_ownerSwap_aRemovedAssetCanBeSoldAndNotBought() public {
        _run(_swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit));
        vm.prank(admin);
        factory.removeAsset(address(stockA));

        Swap memory buy = _swap(direct, address(cash), address(stockA), 100 * USD, unit / 2);
        _expectRevert(buy, abi.encodeWithSelector(IBasketVault.TokenNotAccepted.selector, address(stockA)));

        _run(_swap(direct, address(stockA), address(cash), unit, 195 * USD));
        assertEq(stockA.balanceOf(address(vault)), 2 * unit);
        assertEq(cash.balanceOf(address(vault)), 595 * USD);

        vm.prank(owner);
        vault.withdraw(address(stockA), 2 * unit);
        assertEq(stockA.balanceOf(owner), 2 * unit);
    }

    function test_ownerSwap_aRouterThatReverts_failsWithItsReason() public {
        Swap memory s = _swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit);
        // The router's reserve is gone: its own payment fails.
        stockA.seize(address(direct), attacker, stockA.balanceOf(address(direct)));
        _expectRevert(
            s,
            abi.encodeWithSelector(
                IBasketVault.RouterFailed.selector, address(direct), abi.encodePacked(MockRouter.PayFailed.selector)
            )
        );
        _assertUntouched();
    }

    /// Permit2 holds an allowance in 160 bits. A larger amount is refused, never cut down.
    function test_ownerSwap_permit2_revertsOnAnAmountItCannotHold() public {
        uint256 tooLarge = uint256(type(uint160).max) + 1;
        Swap memory s = _swap(viaPermit2, address(cash), address(stockA), tooLarge, 3 * unit);
        _expectRevert(s, abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, uint8(160), tooLarge));
        _assertUntouched();
    }

    /// A8, the owner's half, and I4: the guardian's pause, a halt and the market calendar are the keeper's
    /// limits. The owner deposits, trades and withdraws through all of them.
    function test_A8_ownerPath_isNeverBlockedByTheGuardian() public {
        vm.startPrank(guardian);
        factory.pauseKeeper();
        factory.haltAsset(address(stockA), type(uint64).max);
        factory.haltAsset(address(cash), type(uint64).max);
        factory.extendClosedUntil(type(uint64).max);
        factory.addClosedDay(uint32(block.timestamp / 1 days));
        vm.stopPrank();
        assertTrue(factory.keeperPaused());

        vm.startPrank(owner);
        vault.deposit(10 * USD);
        vault.ownerSwap(_swaps(_swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit)), LATER);
        vault.setTargets(new Weight[](0));
        vault.withdraw(address(stockA), unit);
        assertEq(vault.withdrawAll().length, 0);
        vm.stopPrank();
        assertEq(stockA.balanceOf(owner), 3 * unit);
        assertEq(cash.balanceOf(address(vault)), 0);
    }

    // ---- a router that cheats: each way is caught by the vault's own balances

    /// It takes more of the input than `amountIn`, through the token's back door.
    function test_hostile_takesMoreThanAmountIn() public {
        Swap memory s = _swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit);
        s.data = abi.encodeCall(
            MockRouter.swapAndSeize, (address(cash), address(stockA), 600 * USD, 3 * unit, address(cash), 1)
        );
        _expectRevert(
            s, abi.encodeWithSelector(IBasketVault.SpentTooMuch.selector, address(cash), 600 * USD + 1, 600 * USD)
        );
        _assertUntouched();
    }

    function test_hostile_paysLessThanMinOut() public {
        Swap memory s = _swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit);
        s.data = abi.encodeCall(MockRouter.swap, (address(cash), address(stockA), 600 * USD, 3 * unit - 1));
        _expectRevert(
            s, abi.encodeWithSelector(IBasketVault.ReceivedTooLittle.selector, address(stockA), 3 * unit - 1, 3 * unit)
        );
        _assertUntouched();
    }

    /// A1: the output goes to someone else. The vault's balance did not rise, whatever the router did.
    function test_A1_hostile_sendsTheOutputElsewhere() public {
        Swap memory s = _swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit);
        s.data = abi.encodeCall(MockRouter.swapTo, (address(cash), address(stockA), 600 * USD, 3 * unit, attacker));
        _expectRevert(s, abi.encodeWithSelector(IBasketVault.ReceivedTooLittle.selector, address(stockA), 0, 3 * unit));
        _assertUntouched();
        assertEq(stockA.balanceOf(attacker), 0);
    }

    function test_hostile_paysADifferentToken() public {
        Swap memory s = _swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit);
        s.data = abi.encodeCall(MockRouter.swap, (address(cash), address(stockB), 600 * USD, 3 * unit));
        _expectRevert(s, abi.encodeWithSelector(IBasketVault.ReceivedTooLittle.selector, address(stockA), 0, 3 * unit));
        _assertUntouched();
        assertEq(stockB.balanceOf(address(vault)), 0);
    }

    /// The trade itself is honest, and a token that was no part of it goes down.
    function test_hostile_drainsAnotherToken() public {
        _run(_swap(direct, address(cash), address(stockB), 100 * USD, 2 * unit));
        Swap memory s = _swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit);
        s.data = abi.encodeCall(
            MockRouter.swapAndSeize, (address(cash), address(stockA), 600 * USD, 3 * unit, address(stockB), 1)
        );
        _expectRevert(
            s, abi.encodeWithSelector(IBasketVault.OtherTokenDebited.selector, address(stockB), 2 * unit, 2 * unit - 1)
        );
        assertEq(stockB.balanceOf(address(vault)), 2 * unit);
        assertEq(cash.balanceOf(address(vault)), 900 * USD);
    }

    /// The trade is honest, and a token that was no part of it stops answering for its balance. The vault
    /// cannot tell that it still holds it, so the swap fails.
    function test_hostile_makesAnotherTokenUnreadable() public {
        FreezableToken frozen = new FreezableToken(dec);
        _list(address(frozen), dec);
        frozen.mint(address(direct), 10 * unit);
        _run(_swap(direct, address(cash), address(frozen), 100 * USD, 2 * unit));

        Swap memory s = _swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit);
        s.data = abi.encodeCall(
            MockRouter.swapAndCall,
            (
                address(cash),
                address(stockA),
                600 * USD,
                3 * unit,
                address(frozen),
                abi.encodeCall(FreezableToken.setBricked, (true))
            )
        );
        _expectRevert(
            s,
            abi.encodeWithSelector(
                IBasketVault.OtherTokenDebited.selector, address(frozen), 2 * unit, type(uint256).max
            )
        );
        assertEq(cash.balanceOf(address(vault)), 900 * USD);
    }

    /// A token that was sent to the vault from outside is not in `tokens`. Once the owner trades it, it is:
    /// its balance is held to the swap's limit like any other, and `withdrawAll` covers what is left.
    function test_ownerSwap_aTokenSentInFromOutside_isTrackedOnceTraded() public {
        stockB.mint(address(vault), 10 * unit);
        assertEq(vault.tokens().length, 1);

        Swap memory greedy = _swap(direct, address(stockB), address(cash), unit, 100 * USD);
        greedy.data = abi.encodeCall(
            MockRouter.swapAndSeize, (address(stockB), address(cash), unit, 100 * USD, address(stockB), 1)
        );
        _expectRevert(
            greedy, abi.encodeWithSelector(IBasketVault.SpentTooMuch.selector, address(stockB), unit + 1, unit)
        );

        _run(_swap(direct, address(stockB), address(cash), unit, 100 * USD));
        address[] memory tracked = vault.tokens();
        assertEq(tracked.length, 2);
        assertEq(tracked[1], address(stockB));

        vm.prank(owner);
        assertEq(vault.withdrawAll().length, 0);
        assertEq(stockB.balanceOf(owner), 9 * unit);
    }

    // ---- the approval is for exactly `amountIn`

    /// A router that simply asks the token for more than `amountIn` gets nothing: the allowance is exact.
    function test_exactApproval_direct_aLargerPullFailsAtTheToken() public {
        Swap memory s = _swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit);
        s.data = abi.encodeCall(MockRouter.swap, (address(cash), address(stockA), 600 * USD + 1, 3 * unit));
        _expectRevert(
            s,
            abi.encodeWithSelector(
                IBasketVault.RouterFailed.selector, address(direct), abi.encodePacked(MockRouter.PullFailed.selector)
            )
        );
        _assertUntouched();
    }

    /// Through Permit2 there are two allowances, and each is exact on its own. Here Permit2 keeps no count,
    /// so the only limit is the vault's allowance to Permit2 on the token.
    function test_exactApproval_permit2_theTokenAllowanceIsExact() public {
        vm.etch(PERMIT2_ADDRESS, address(new GreedyPermit2()).code);
        Swap memory s = _swap(viaPermit2, address(cash), address(stockA), 600 * USD, 3 * unit);
        s.data = abi.encodeCall(MockRouter.swap, (address(cash), address(stockA), 600 * USD + 1, 3 * unit));
        _expectRevert(
            s,
            abi.encodeWithSelector(
                IBasketVault.RouterFailed.selector,
                address(viaPermit2),
                abi.encodePacked(MockRouter.PullFailed.selector)
            )
        );
        _assertUntouched();
    }

    /// And here the token lets Permit2 move anything, so the only limit is the amount inside Permit2.
    function test_exactApproval_permit2_theAmountInsidePermit2IsExact() public {
        PermissiveToken loose = new PermissiveToken(6);
        _list(address(loose), 6);
        loose.mint(address(vault), 1000 * USD);
        Swap memory s = _swap(viaPermit2, address(loose), address(stockA), 600 * USD, 3 * unit);
        s.data = abi.encodeCall(MockRouter.swap, (address(loose), address(stockA), 600 * USD + 1, 3 * unit));
        _expectRevert(
            s,
            abi.encodeWithSelector(
                IBasketVault.RouterFailed.selector,
                address(viaPermit2),
                abi.encodePacked(MockRouter.PullFailed.selector)
            )
        );
        assertEq(loose.balanceOf(address(vault)), 1000 * USD);
    }

    /// Inside Permit2 the allowance is also short-lived: it ends with the block the swap is in. Seen from
    /// the middle of a swap, after the router took 100 of the 300 it was approved for.
    function test_exactApproval_permit2_endsWithTheBlock() public {
        vm.warp(1_791_212_400);
        Permit2Witness witness = new Permit2Witness();
        Swap memory s = _swap(viaPermit2, address(cash), address(stockA), 300 * USD, unit);
        s.data = abi.encodeCall(
            MockRouter.swapAndCall,
            (
                address(cash),
                address(stockA),
                100 * USD,
                unit,
                address(witness),
                abi.encodeCall(Permit2Witness.look, (address(vault), address(cash), address(viaPermit2)))
            )
        );
        _run(s);
        assertEq(witness.amount(), 200 * USD, "what was left of the approval while the swap ran");
        assertEq(witness.expiration(), block.timestamp, "good for this block and no longer");
        _assertNoAllowance(address(vault), address(cash), address(viaPermit2));
    }

    // ---- A11 and I3: no allowance outlives the swap

    /// The router takes less than it was approved for. What it did not use is taken back, both ways of
    /// pulling.
    function test_A11_routerTakesLess_noAllowanceIsLeft() public {
        MockRouter[2] memory routers = [direct, viaPermit2];
        for (uint256 i; i < routers.length; ++i) {
            Swap memory s = _swap(routers[i], address(cash), address(stockA), 300 * USD, unit);
            s.data = abi.encodeCall(MockRouter.swap, (address(cash), address(stockA), 100 * USD, unit));
            vm.expectEmit(address(vault));
            emit IBasketVault.OwnerTrade(address(vault), address(cash), address(stockA), 100 * USD, unit);
            _run(s);
            _assertNoAllowance(address(vault), address(cash), address(routers[i]));
        }
        assertEq(cash.balanceOf(address(vault)), 800 * USD);
    }

    /// A token whose `approve(spender, 0)` changes nothing: the vault reads the allowance back and refuses
    /// the swap, so the approval is undone with it.
    function test_A11_aTokenThatKeepsItsAllowance_failsTheSwap() public {
        StickyToken sticky = new StickyToken(6);
        _list(address(sticky), 6);
        sticky.mint(address(vault), 1000 * USD);
        Swap memory s = _swap(direct, address(sticky), address(stockA), 300 * USD, unit);
        s.data = abi.encodeCall(MockRouter.swap, (address(sticky), address(stockA), 100 * USD, unit));
        _expectRevert(
            s, abi.encodeWithSelector(IBasketVault.AllowanceLeft.selector, address(sticky), address(direct), 200 * USD)
        );
        assertEq(sticky.allowance(address(vault), address(direct)), 0);
        assertEq(sticky.balanceOf(address(vault)), 1000 * USD);
    }

    /// The same with a Permit2 that does not take an allowance back.
    function test_A11_aPermit2ThatKeepsItsAllowance_failsTheSwap() public {
        vm.etch(PERMIT2_ADDRESS, address(new StickyPermit2()).code);
        Swap memory s = _swap(viaPermit2, address(cash), address(stockA), 300 * USD, unit);
        s.data = abi.encodeCall(MockRouter.swap, (address(cash), address(stockA), 100 * USD, unit));
        _expectRevert(
            s,
            abi.encodeWithSelector(IBasketVault.AllowanceLeft.selector, address(cash), address(viaPermit2), 200 * USD)
        );
        _assertUntouched();
    }

    // ---- a token, Permit2 or the vault as the "router"

    /// With a token as the router, `data` can be `approve(attacker, max)`: no balance moves, so no balance
    /// check sees it. The config never lists such a router, and the vault does not take its word for it.
    function test_hostile_approveAsItsSwap_isRefusedTwice() public {
        _run(_swap(direct, address(cash), address(stockB), 100 * USD, 2 * unit));
        bytes memory approveAll = abi.encodeCall(IERC20.approve, (attacker, type(uint256).max));

        // The config: a listed asset, a removed one, and a token that was never listed.
        BackdoorToken stray = new BackdoorToken(dec);
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.RouterIsAsset.selector, address(stockB)));
        factory.setRouter(address(stockB), 1);
        factory.removeAsset(address(stockC));
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.RouterIsAsset.selector, address(stockC)));
        factory.setRouter(address(stockC), 1);
        vm.expectRevert(abi.encodeWithSelector(IVaultConfig.RouterIsToken.selector, address(stray)));
        factory.setRouter(address(stray), 1);
        vm.stopPrank();

        Swap memory s = Swap(address(stockB), address(cash), address(stockA), 1, 0, approveAll);
        _expectRevert(s, abi.encodeWithSelector(IBasketVault.RouterNotAllowed.selector, address(stockB)));

        // The vault, had the config said yes: a token it holds is never called as a router.
        vm.mockCall(address(factory), abi.encodeCall(IVaultConfig.routerPull, (address(stockB))), abi.encode(uint8(1)));
        _expectRevert(s, abi.encodeWithSelector(IBasketVault.RouterNotAllowed.selector, address(stockB)));
        assertEq(stockB.allowance(address(vault), attacker), 0);
    }

    /// The same in one batch, in the order that hides it: the token is the "router" of the first swap and
    /// only joins the vault's tokens with the second, which buys it. The vault looks at every router after
    /// the whole batch's tokens are in, so the order does not matter. The config is made to say yes here; the
    /// real one never does.
    function test_hostile_approveAsItsSwap_onATokenBoughtLaterInTheBatch_isRefused() public {
        vm.mockCall(address(factory), abi.encodeCall(IVaultConfig.routerPull, (address(stockC))), abi.encode(uint8(1)));
        Swap[] memory swaps = new Swap[](2);
        swaps[0] = Swap(
            address(stockC),
            address(cash),
            address(stockA),
            1,
            0,
            abi.encodeCall(IERC20.approve, (attacker, type(uint256).max))
        );
        swaps[1] = _swap(direct, address(cash), address(stockC), 100 * USD, 2 * unit);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.RouterNotAllowed.selector, address(stockC)));
        vault.ownerSwap(swaps, LATER);
        assertEq(stockC.allowance(address(vault), attacker), 0);
        _assertUntouched();
    }

    function test_hostile_permit2OrTheVaultAsRouter_isRefusedTwice() public {
        address[2] memory reserved = [PERMIT2_ADDRESS, address(vault)];
        for (uint256 i; i < reserved.length; ++i) {
            vm.prank(admin);
            vm.expectRevert(abi.encodeWithSelector(IVaultConfig.RouterReserved.selector, reserved[i]));
            factory.setRouter(reserved[i], 1);

            Swap memory s = Swap(reserved[i], address(cash), address(stockA), 600 * USD, 0, "");
            _expectRevert(s, abi.encodeWithSelector(IBasketVault.RouterNotAllowed.selector, reserved[i]));

            vm.mockCall(address(factory), abi.encodeCall(IVaultConfig.routerPull, (reserved[i])), abi.encode(uint8(1)));
            _expectRevert(s, abi.encodeWithSelector(IBasketVault.RouterNotAllowed.selector, reserved[i]));
        }
        _assertUntouched();
    }

    // ---- A17: a router or a hooked pool calls back into the vault mid-swap

    /// Only the owner gets past the owner check, so the re-entering caller here is an owner that is also
    /// the router. Every function that changes state is tried as the inner call, `multicall` included.
    function test_A17_reentryMidSwap_isRefused() public {
        MockRouter both = new MockRouter(false);
        vm.prank(admin);
        factory.setRouter(address(both), 1);
        stockA.mint(address(both), 100 * unit);
        cash.mint(address(both), 1000 * USD);
        BasketVault mine = _createVault(address(both), keccak256("plan-router"));
        both.act(address(cash), abi.encodeCall(IERC20.approve, (address(mine), type(uint256).max)));
        both.act(address(mine), abi.encodeCall(BasketVault.deposit, (1000 * USD)));

        Swap[] memory nested = _swaps(_swap(both, address(cash), address(stockA), 1 * USD, 1));
        bytes[] memory batch = new bytes[](1);
        batch[0] = abi.encodeCall(BasketVault.withdraw, (address(cash), 1));
        bytes[6] memory inner = [
            abi.encodeCall(BasketVault.withdraw, (address(cash), 1)),
            abi.encodeCall(BasketVault.withdrawAll, ()),
            abi.encodeCall(BasketVault.deposit, (0)),
            abi.encodeCall(BasketVault.ownerSwap, (nested, LATER)),
            abi.encodeCall(BasketVault.setTargets, (new Weight[](0))),
            abi.encodeCall(IBasketVault.multicall, (batch))
        ];
        bytes memory reentered = abi.encodePacked(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        for (uint256 i; i < inner.length; ++i) {
            Swap memory s = _swap(both, address(cash), address(stockA), 600 * USD, 3 * unit);
            s.data = abi.encodeCall(
                MockRouter.swapAndCall, (address(cash), address(stockA), 600 * USD, 3 * unit, address(mine), inner[i])
            );
            vm.expectRevert(abi.encodeWithSelector(IBasketVault.RouterFailed.selector, address(both), reentered));
            both.act(address(mine), abi.encodeCall(BasketVault.ownerSwap, (_swaps(s), LATER)));

            // The same through `multicall` as the outer call: a batch is not a way round the guard.
            bytes[] memory outer = new bytes[](1);
            outer[0] = abi.encodeCall(BasketVault.ownerSwap, (_swaps(s), LATER));
            vm.expectRevert(abi.encodeWithSelector(IBasketVault.RouterFailed.selector, address(both), reentered));
            both.act(address(mine), abi.encodeCall(IBasketVault.multicall, (outer)));
        }
        assertEq(cash.balanceOf(address(mine)), 1000 * USD, "no inner call ran");
        assertEq(stockA.balanceOf(address(mine)), 0);
    }

    /// The first swaps of a new vault run inside `start`, under the same guard: a router that is also the
    /// owner cannot withdraw in the middle of the first buy.
    function test_A17_reentryDuringTheFirstBuy_isRefused() public {
        MockRouter both = new MockRouter(false);
        vm.prank(admin);
        factory.setRouter(address(both), 1);
        stockA.mint(address(both), 100 * unit);
        cash.mint(address(both), 1000 * USD);
        bytes32 planId = keccak256("plan-router");
        address predicted = factory.vaultOf(address(both), planId);
        both.act(address(cash), abi.encodeCall(IERC20.approve, (predicted, type(uint256).max)));

        Swap memory s = _swap(both, address(cash), address(stockA), 600 * USD, 3 * unit);
        s.data = abi.encodeCall(
            MockRouter.swapAndCall,
            (
                address(cash),
                address(stockA),
                600 * USD,
                3 * unit,
                predicted,
                abi.encodeCall(BasketVault.withdraw, (address(cash), 400 * USD))
            )
        );
        bytes memory create = abi.encodeCall(
            factory.createVaultAndBuy, (planId, new Weight[](0), bytes32(0), 0, false, 1000 * USD, _swaps(s), LATER)
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                IBasketVault.RouterFailed.selector,
                address(both),
                abi.encodePacked(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
            )
        );
        both.act(address(factory), create);
        assertEq(predicted.code.length, 0);
    }

    /// A router that is not the owner re-enters and meets the owner check; `start` is not the owner's and
    /// meets its own.
    function test_A17_reentryByAStranger_isRefused() public {
        bytes[2] memory inner = [
            abi.encodeCall(BasketVault.withdrawAll, ()),
            abi.encodeCall(BasketVault.start, (bytes32(0), 0, new Weight[](0), false, 0, new Swap[](0)))
        ];
        bytes[2] memory reasons = [
            abi.encodeWithSelector(IBasketVault.NotOwner.selector, address(direct)),
            abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector)
        ];
        for (uint256 i; i < inner.length; ++i) {
            Swap memory s = _swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit);
            s.data = abi.encodeCall(
                MockRouter.swapAndCall, (address(cash), address(stockA), 600 * USD, 3 * unit, address(vault), inner[i])
            );
            _expectRevert(s, abi.encodeWithSelector(IBasketVault.RouterFailed.selector, address(direct), reasons[i]));
        }
        _assertUntouched();
    }

    // ---- multicall: a batch works, each inner call keeps its own checks

    function test_multicall_batchesTheOwnersCalls() public {
        Weight[] memory targets = _targets(address(stockA), 6000, address(stockB), 3000);
        bytes[] memory calls = new bytes[](4);
        calls[0] = abi.encodeCall(BasketVault.deposit, (500 * USD));
        calls[1] = abi.encodeCall(
            BasketVault.ownerSwap, (_swaps(_swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit)), LATER)
        );
        calls[2] = abi.encodeCall(BasketVault.setTargets, (targets));
        calls[3] = abi.encodeCall(BasketVault.tokens, ());

        vm.prank(owner);
        bytes[] memory results = vault.multicall(calls);

        assertEq(cash.balanceOf(address(vault)), 900 * USD);
        assertEq(stockA.balanceOf(address(vault)), 3 * unit);
        assertEq(vault.targets().length, 2);
        assertEq(abi.decode(results[3], (address[])).length, 2);
    }

    function test_multicall_givesAStrangerNothing() public {
        bytes[] memory calls = new bytes[](1);
        bytes[4] memory tries = [
            abi.encodeCall(BasketVault.withdraw, (address(cash), 1)),
            abi.encodeCall(BasketVault.withdrawAll, ()),
            abi.encodeCall(BasketVault.setTargets, (new Weight[](0))),
            abi.encodeCall(
                BasketVault.ownerSwap, (_swaps(_swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit)), LATER)
            )
        ];
        for (uint256 i; i < tries.length; ++i) {
            calls[0] = tries[i];
            vm.prank(stranger);
            vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, stranger));
            vault.multicall(calls);
        }
        _assertUntouched();
    }

    // ---- a token whose balance cannot be read

    /// A token the issuer has frozen so hard that even its balance cannot be read must not hold up trades
    /// in the others. As the input or the output of the swap itself it fails the swap.
    function test_ownerSwap_anUnreadableTokenBlocksOnlyItsOwnTrades() public {
        FreezableToken frozen = new FreezableToken(dec);
        _list(address(frozen), dec);
        frozen.mint(address(direct), 10 * unit);
        _run(_swap(direct, address(cash), address(frozen), 100 * USD, 2 * unit));
        frozen.setBricked(true);

        _run(_swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit));
        assertEq(stockA.balanceOf(address(vault)), 3 * unit);

        Swap memory sell = _swap(direct, address(frozen), address(cash), unit, 1);
        _expectRevert(sell, abi.encodeWithSelector(IBasketVault.BalanceUnreadable.selector, address(frozen)));
    }

    /// The output token stops answering for its balance in the middle of the swap, and the router pays
    /// nothing. An unreadable balance is not a large one: the swap is refused whatever its `minOut`.
    function test_hostile_theOutputStopsAnsweringMidSwap_isRefused() public {
        FreezableToken frozen = new FreezableToken(dec);
        _list(address(frozen), dec);
        Swap memory s = _swap(direct, address(cash), address(frozen), 600 * USD, 3 * unit);
        s.data = abi.encodeCall(
            MockRouter.swapAndCall,
            (
                address(cash),
                address(frozen),
                600 * USD,
                0,
                address(frozen),
                abi.encodeCall(FreezableToken.setBricked, (true))
            )
        );
        _expectRevert(s, abi.encodeWithSelector(IBasketVault.BalanceUnreadable.selector, address(frozen)));
        assertEq(cash.balanceOf(address(vault)), 1000 * USD, "600 cash was not paid for nothing");
    }

    /// The same for the input: nine units more than `amountIn` are taken through the token's back door and
    /// its balance read is switched off. An unreadable balance is not "nothing spent".
    function test_hostile_theInputStopsAnsweringMidSwap_isRefused() public {
        BrickableBackdoorToken x = new BrickableBackdoorToken(dec);
        _list(address(x), dec);
        x.mint(address(vault), 10 * unit);
        Swap memory s = _swap(direct, address(x), address(cash), unit, 100 * USD);
        s.data = abi.encodeCall(
            MockRouter.swapAndCall,
            (
                address(x),
                address(cash),
                unit,
                100 * USD,
                address(x),
                abi.encodeCall(BrickableBackdoorToken.seizeAndBrick, (address(vault), attacker, 9 * unit))
            )
        );
        _expectRevert(s, abi.encodeWithSelector(IBasketVault.BalanceUnreadable.selector, address(x)));
        x.setBricked(false);
        assertEq(x.balanceOf(address(vault)), 10 * unit, "ten units were not taken against an amountIn of one");
    }

    /// A token that could not be read before the swap is refused as its input even if it answers again by
    /// the end: what the vault had of it is unknown, so what it spent is too.
    function test_ownerSwap_anInputUnreadableBeforeTheSwap_isRefused() public {
        BrickableBackdoorToken x = new BrickableBackdoorToken(dec);
        _list(address(x), dec);
        x.mint(address(vault), 10 * unit);
        x.setBricked(true);
        Swap memory s = _swap(direct, address(x), address(cash), unit, 100 * USD);
        s.data = abi.encodeCall(
            MockRouter.swapAndCall,
            (
                address(x),
                address(cash),
                unit,
                100 * USD,
                address(x),
                abi.encodeCall(BrickableBackdoorToken.setBricked, (false))
            )
        );
        _expectRevert(s, abi.encodeWithSelector(IBasketVault.BalanceUnreadable.selector, address(x)));
        x.setBricked(false);
        assertEq(x.balanceOf(address(vault)), 10 * unit);
    }

    /// The limit of the "no other token went down" check, stated as it is. A tracked token that could not be
    /// read before the swap is left out of it, so that a token frozen by its issuer does not stop trades in
    /// the others. If that token also has a back door, a debit during the swap is not seen. Only the token's
    /// own issuer can do both. For the keeper path this trade is still to be decided.
    function test_ownerSwap_aTokenUnreadableBeforeTheSwap_isNotWatchedDuringIt() public {
        BrickableBackdoorToken x = new BrickableBackdoorToken(dec);
        _list(address(x), dec);
        x.mint(address(direct), 10 * unit);
        _run(_swap(direct, address(cash), address(x), 100 * USD, 2 * unit));
        assertEq(x.balanceOf(address(vault)), 2 * unit);

        x.setBricked(true);
        Swap memory s = _swap(direct, address(cash), address(stockA), 600 * USD, 3 * unit);
        s.data = abi.encodeCall(
            MockRouter.swapAndSeize, (address(cash), address(stockA), 600 * USD, 3 * unit, address(x), 2 * unit)
        );
        _run(s);

        x.setBricked(false);
        assertEq(x.balanceOf(address(vault)), 0, "the debit went through unseen");
        assertEq(stockA.balanceOf(address(vault)), 3 * unit);
    }

    // ---- the owner's own targets

    function test_setTargets_storesThemAndStopsFollowing() public {
        vm.prank(stranger);
        bytes32 id = registry.create(keccak256("family"), _threeStocks(), bytes32(uint256(1)), 0, 0);
        vm.prank(owner);
        BasketVault follower =
            BasketVault(payable(factory.createVault(keccak256("plan-follow"), new Weight[](0), id, 1, false)));

        Weight[] memory targets = _targets(address(stockA), 6000, address(stockB), 2500);
        vm.expectEmit(address(follower));
        emit IBasketVault.Unfollowed(address(follower), id);
        vm.expectEmit(address(follower));
        emit IBasketVault.TargetsSet(address(follower), targets);
        vm.prank(owner);
        follower.setTargets(targets);

        (bytes32 indexId, uint32 version, bool autoFollow) = follower.following();
        assertEq(indexId, bytes32(0));
        assertEq(version, 0);
        assertFalse(autoFollow);
        assertEq(keccak256(abi.encode(follower.targets())), keccak256(abi.encode(targets)));
    }

    /// Nothing in this slot switches auto-follow on, so the flag is written straight into the vault's
    /// storage here. `setTargets` must clear it: targets the owner typed are not something to follow.
    function test_setTargets_switchesAutoFollowOff() public {
        bytes32 slot = bytes32(uint256(_vaultSlot()) + 6);
        vm.store(address(vault), slot, bytes32(uint256(1) << 32));
        (,, bool on) = vault.following();
        assertTrue(on);

        vm.prank(owner);
        vault.setTargets(_targets(address(stockA), 6000, address(stockB), 2500));
        (,, on) = vault.following();
        assertFalse(on);
    }

    function test_setTargets_acceptsTheBoundsThemselves() public {
        // Nothing at all: the vault is all cash.
        vm.startPrank(owner);
        vault.setTargets(_targets(address(stockA), 6000, address(stockB), 2500));
        vault.setTargets(new Weight[](0));
        assertEq(vault.targets().length, 0);

        // 100% in two assets, a zero weight, and sixteen assets.
        vault.setTargets(_targets(address(stockA), 10_000, address(stockB), 0));
        vm.stopPrank();
        Weight[] memory sixteen = _manyTargets(16);
        vm.prank(owner);
        vault.setTargets(sixteen);
        assertEq(vault.targets().length, 16);
    }

    function test_setTargets_revertsOnTargetsThatAreNotAllowed() public {
        Weight[] memory seventeen = _manyTargets(17);
        _expectInvalidTargets(seventeen, 1);

        Weight[] memory unsorted = _targets(address(stockA), 6000, address(stockB), 2500);
        (unsorted[0], unsorted[1]) = (unsorted[1], unsorted[0]);
        _expectInvalidTargets(unsorted, 2);

        Weight[] memory twice = _targets(address(stockA), 6000, address(stockB), 2500);
        twice[1].token = twice[0].token;
        _expectInvalidTargets(twice, 2);

        BackdoorToken stray = new BackdoorToken(dec);
        _expectInvalidTargets(_targets(address(stockA), 6000, address(stray), 2500), 3);
        Weight[] memory zero = new Weight[](1);
        _expectInvalidTargets(zero, 3);

        vm.prank(admin);
        factory.removeAsset(address(stockC));
        _expectInvalidTargets(_targets(address(stockA), 6000, address(stockC), 2500), 3);

        _expectInvalidTargets(_targets(address(stockA), 6000, address(cash), 2500), 4);
        _expectInvalidTargets(_targets(address(stockA), 6000, address(stockB), 4001), 5);
        assertEq(vault.targets().length, 0);
    }

    function test_setTargets_revertsForAnyoneButTheOwner() public {
        Weight[] memory targets = _targets(address(stockA), 6000, address(stockB), 2500);
        address[4] memory callers = [stranger, admin, keeper, address(factory)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, callers[i]));
            vault.setTargets(targets);
        }
        assertEq(vault.targets().length, 0);
    }

    function _expectInvalidTargets(Weight[] memory targets, uint8 reason) internal {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.InvalidTargets.selector, reason));
        vault.setTargets(targets);
    }

    /// `n` listed assets at 100 bps each, sorted.
    function _manyTargets(uint256 n) internal returns (Weight[] memory list) {
        list = new Weight[](n);
        for (uint256 i; i < n; ++i) {
            address token = address(new MockToken(dec));
            _list(token, dec);
            list[i] = Weight(token, 100);
        }
        return _sort(list);
    }

    function _vaultSlot() internal pure returns (bytes32) {
        return keccak256(abi.encode(uint256(keccak256("basket.storage.BasketVault")) - 1)) & ~bytes32(uint256(0xff));
    }
}

contract OwnerSwap6Test is OwnerSwapTest {
    function _decimals() internal pure override returns (uint8) {
        return 6;
    }
}

contract OwnerSwap8Test is OwnerSwapTest {
    function _decimals() internal pure override returns (uint8) {
        return 8;
    }
}

contract OwnerSwap18Test is OwnerSwapTest {
    function _decimals() internal pure override returns (uint8) {
        return 18;
    }
}
