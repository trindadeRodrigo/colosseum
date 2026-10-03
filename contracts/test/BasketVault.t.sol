// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {IBasketVault} from "../src/interfaces/IBasketVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {VaultFixture} from "./helpers/VaultFixture.sol";
import {
    FalseReturnToken,
    FeeToken,
    FreezableToken,
    HookToken,
    MockToken,
    NoReturnToken,
    ShortAnswerToken,
    StockLikeToken,
    TokenBase
} from "./mocks/Tokens.sol";

interface ITestToken {
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(address spender, uint256 amount) external;
}

/// The owner path of the vault: deposit the cash token, and withdraw any token in kind to the owner only.
/// Every test runs at 6, 8 and 18 decimals through the three contracts at the end of this file.
///
/// The swaps have their own file. Here a test that needs several tokens in a vault's `tokens` list deposits
/// each one while it is the cash token (`_put`).
///
/// TNET-1 runs this suite against the test-network tokens by overriding `_newToken` and `_mint`.
abstract contract BasketVaultTest is VaultFixture {
    uint8 internal dec;
    uint256 internal unit;
    uint256 internal funded;

    address internal cash;
    address internal stock;
    FalseReturnToken internal falseToken;
    NoReturnToken internal noReturnToken;
    FeeToken internal feeToken;
    FreezableToken internal frozenToken;

    function _decimals() internal pure virtual returns (uint8);

    /// A well-behaved token with `decimals_` decimals.
    function _newToken(uint8 decimals_) internal virtual returns (address) {
        return address(new MockToken(decimals_));
    }

    function _mint(address token, address to, uint256 amount) internal virtual {
        MockToken(token).mint(to, amount);
    }

    function setUp() public virtual {
        dec = _decimals();
        unit = 10 ** dec;
        funded = 1_000_000 * unit;
        _deployPlatform();

        cash = _newToken(dec);
        stock = _newToken(dec);
        falseToken = new FalseReturnToken(dec);
        noReturnToken = new NoReturnToken(dec);
        feeToken = new FeeToken(dec, 0);
        frozenToken = new FreezableToken(dec);

        _mint(cash, owner, funded);
        _mint(stock, owner, funded);
        address[4] memory odd = [address(falseToken), address(noReturnToken), address(feeToken), address(frozenToken)];
        for (uint256 i; i < odd.length; ++i) {
            MockToken(odd[i]).mint(owner, funded);
        }

        address[6] memory all = [cash, stock, odd[0], odd[1], odd[2], odd[3]];
        for (uint256 i; i < all.length; ++i) {
            _listAndApprove(all[i]);
        }
        _setCash(cash);
    }

    function _listAndApprove(address token) internal {
        _list(token, dec);
        vm.prank(owner);
        ITestToken(token).approve(address(vault), type(uint256).max);
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return ITestToken(token).balanceOf(who);
    }

    /// Deposits the cash token as the owner.
    function _deposit(uint256 amount) internal {
        vm.prank(owner);
        vault.deposit(amount);
    }

    /// Puts `token` into the vault and its list, as the cash token of the moment.
    function _put(address token, uint256 amount) internal {
        _depositAs(vault, token, amount);
    }

    // ---- initialise

    function test_initialize_setsOwnerPlanAndConfig() public view {
        assertEq(vault.owner(), owner);
        assertEq(vault.planId(), PLAN_ID);
        assertEq(vault.config(), address(factory));
        assertEq(vault.tokens().length, 0);
    }

    function test_initialize_revertsOnZeroOwner() public {
        bytes memory init = abi.encodeCall(BasketVault.initialize, (address(0), PLAN_ID));
        vm.expectRevert(IBasketVault.ZeroAddress.selector);
        new BeaconProxy(address(beacon), init);
    }

    /// The config is whoever created the proxy, never an argument: a vault cannot be pointed at a config
    /// that did not create it.
    function test_initialize_takesItsCreatorAsTheConfig() public {
        bytes memory init = abi.encodeCall(BasketVault.initialize, (owner, PLAN_ID));
        BasketVault bare = BasketVault(payable(address(new BeaconProxy(address(beacon), init))));
        assertEq(bare.config(), address(this));
        assertFalse(factory.isVault(address(bare)));
    }

    function test_A15_initialize_revertsOnLiveProxy() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(stranger, PLAN_ID);

        vm.prank(owner);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(stranger, PLAN_ID);

        vm.prank(address(factory));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(stranger, PLAN_ID);

        assertEq(vault.owner(), owner);
    }

    function test_A15_initialize_revertsOnLogicContract() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        logic.initialize(stranger, PLAN_ID);
        assertEq(logic.owner(), address(0));
    }

    // ---- deposit: the cash token only (gate DEPOSIT)

    function test_deposit_pullsTheCashTokenAndTracksIt() public {
        _deposit(100 * unit);
        assertEq(_bal(cash, address(vault)), 100 * unit);
        assertEq(_bal(cash, owner), funded - 100 * unit);

        _deposit(1);
        address[] memory tracked = vault.tokens();
        assertEq(tracked.length, 1, "one entry per token");
        assertEq(tracked[0], cash);
        assertEq(_bal(cash, address(vault)), 100 * unit + 1);
        assertEq(_bal(stock, owner), funded, "no other token moved");
    }

    /// The vault has no way to name another token: the two-argument deposit is gone.
    function test_deposit_takesNoTokenArgument() public {
        vm.prank(owner);
        (bool ok,) = address(vault).call(abi.encodeWithSignature("deposit(address,uint256)", stock, 10 * unit));
        assertFalse(ok);
        assertEq(_bal(stock, address(vault)), 0);
        assertEq(vault.tokens().length, 0);
    }

    /// The cash token is read from the config on every deposit, never fixed in the vault.
    function test_deposit_followsTheConfigsCashToken() public {
        _deposit(100 * unit);
        _setCash(stock);
        _deposit(3 * unit);

        assertEq(_bal(cash, address(vault)), 100 * unit);
        assertEq(_bal(stock, address(vault)), 3 * unit);
        address[] memory tracked = vault.tokens();
        assertEq(tracked.length, 2);
        assertEq(tracked[0], cash);
        assertEq(tracked[1], stock);
    }

    function test_deposit_revertsWhenNoCashTokenIsSet() public {
        VaultFactory bare = _newFactory();
        BasketVault bareVault = _createVault(bare, owner, keccak256("plan-bare"));
        vm.prank(owner);
        vm.expectRevert(IBasketVault.CashTokenNotSet.selector);
        bareVault.deposit(1);
    }

    function test_deposit_revertsForStranger() public {
        _mint(cash, stranger, 10 * unit);
        vm.startPrank(stranger);
        ITestToken(cash).approve(address(vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, stranger));
        vault.deposit(10 * unit);
        vm.stopPrank();
        assertEq(_bal(cash, address(vault)), 0);
    }

    function test_deposit_cashTokenReturningFalse() public {
        _setCash(address(falseToken));
        _deposit(50 * unit);
        assertEq(falseToken.balanceOf(address(vault)), 50 * unit);

        // No allowance left: the token answers `false` and moves nothing. The vault must not count it.
        vm.startPrank(owner);
        falseToken.approve(address(vault), 0);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(falseToken)));
        vault.deposit(50 * unit);
        vm.stopPrank();
        assertEq(falseToken.balanceOf(address(vault)), 50 * unit);
    }

    function test_deposit_cashTokenReturningNothing() public {
        _setCash(address(noReturnToken));
        _deposit(50 * unit);
        assertEq(noReturnToken.balanceOf(address(vault)), 50 * unit);
        assertEq(noReturnToken.balanceOf(owner), funded - 50 * unit);
    }

    function test_deposit_feeOnTransferCash_isRejected() public {
        _setCash(address(feeToken));
        feeToken.setFeeBps(100);
        uint256 amount = 200 * unit;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IBasketVault.DepositShortfall.selector, address(feeToken), amount, amount - amount / 100
            )
        );
        vault.deposit(amount);
        assertEq(feeToken.balanceOf(address(vault)), 0);
        assertEq(feeToken.balanceOf(owner), funded);
    }

    // ---- withdraw: any token the vault holds, to the owner only

    function test_withdraw_paysTheOwner() public {
        _deposit(100 * unit);
        vm.prank(owner);
        vault.withdraw(cash, 40 * unit);
        assertEq(_bal(cash, address(vault)), 60 * unit);
        assertEq(_bal(cash, owner), funded - 60 * unit);
    }

    function test_I1_withdraw_revertsForAnyoneButTheOwner() public {
        _deposit(100 * unit);
        address[6] memory callers = [stranger, admin, address(factory), address(beacon), address(logic), address(vault)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, callers[i]));
            vault.withdraw(cash, 1);

            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, callers[i]));
            vault.withdrawAll();
        }
        assertEq(_bal(cash, address(vault)), 100 * unit);
    }

    /// The rig's vault took a recipient. This one has no function that does.
    function test_I1_noFunctionTakesARecipient() public {
        _deposit(100 * unit);
        vm.startPrank(owner);
        (bool ok,) =
            address(vault).call(abi.encodeWithSignature("withdraw(address,uint256,address)", cash, 1, stranger));
        assertFalse(ok, "withdraw to a recipient");
        (ok,) = address(vault).call(abi.encodeWithSignature("withdrawAll(address)", stranger));
        assertFalse(ok, "withdrawAll to a recipient");
        vm.stopPrank();
        assertEq(_bal(cash, stranger), 0);
        assertEq(_bal(cash, address(vault)), 100 * unit);
    }

    function test_I1_ownerOfOneVaultCannotTouchAnother() public {
        address other = makeAddr("other-owner");
        BasketVault otherVault = _createVault(other, keccak256("plan-2"));
        _mint(cash, address(otherVault), 5 * unit);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, owner));
        otherVault.withdraw(cash, 5 * unit);

        vm.prank(other);
        otherVault.withdraw(cash, 5 * unit);
        assertEq(_bal(cash, other), 5 * unit);
    }

    function test_withdraw_tokenReturningFalse() public {
        _put(address(falseToken), 50 * unit);
        vm.startPrank(owner);
        vault.withdraw(address(falseToken), 20 * unit);
        assertEq(falseToken.balanceOf(owner), funded - 30 * unit);

        // More than the vault holds: the token answers `false`. The call must fail, not pass silently.
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(falseToken)));
        vault.withdraw(address(falseToken), 31 * unit);
        vm.stopPrank();
        assertEq(falseToken.balanceOf(address(vault)), 30 * unit);
    }

    function test_withdraw_tokenReturningNothing() public {
        _put(address(noReturnToken), 50 * unit);
        vm.prank(owner);
        vault.withdraw(address(noReturnToken), 20 * unit);
        assertEq(noReturnToken.balanceOf(address(vault)), 30 * unit);
        assertEq(noReturnToken.balanceOf(owner), funded - 30 * unit);
    }

    /// A token that starts skimming after the deposit can still leave. The owner receives what the token delivers.
    function test_withdraw_feeSwitchedOnAfterDeposit() public {
        _put(address(feeToken), 100 * unit);
        feeToken.setFeeBps(100);
        vm.prank(owner);
        vault.withdraw(address(feeToken), 100 * unit);
        assertEq(feeToken.balanceOf(address(vault)), 0);
        assertEq(feeToken.balanceOf(owner), funded - unit);
    }

    /// A10's shape, and gate DEPOSIT's second half: a token sent to the vault from outside cannot be stopped.
    /// It counts for nothing (it is not in `tokens`, and `withdrawAll` does not see it), and the owner, only
    /// the owner, can take it out.
    function test_A10_withdraw_tokenSentFromOutside() public {
        address unlisted = _newToken(dec);
        _mint(unlisted, address(vault), 7 * unit);
        assertEq(vault.tokens().length, 0);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, stranger));
        vault.withdraw(unlisted, 7 * unit);

        vm.startPrank(owner);
        address[] memory skipped = vault.withdrawAll();
        assertEq(skipped.length, 0);
        assertEq(_bal(unlisted, address(vault)), 7 * unit, "the sweep walks the list and nothing else");

        vault.withdraw(unlisted, 7 * unit);
        vm.stopPrank();
        assertEq(_bal(unlisted, owner), 7 * unit);
    }

    // ---- withdrawAll and a frozen token (A9)

    function test_withdrawAll_sendsEverythingToTheOwner() public {
        _put(cash, 100 * unit);
        _put(stock, 2 * unit);
        _put(address(noReturnToken), 5 * unit);
        _put(address(falseToken), 6 * unit);
        address[4] memory held = [cash, stock, address(noReturnToken), address(falseToken)];
        for (uint256 i; i < held.length; ++i) {
            assertGt(_bal(held[i], address(vault)), 0);
        }

        vm.prank(owner);
        address[] memory skipped = vault.withdrawAll();

        assertEq(skipped.length, 0);
        for (uint256 i; i < held.length; ++i) {
            assertEq(_bal(held[i], address(vault)), 0);
            assertEq(_bal(held[i], owner), funded);
        }
    }

    function test_withdrawAll_onAnEmptyVault() public {
        vm.prank(owner);
        address[] memory skipped = vault.withdrawAll();
        assertEq(skipped.length, 0);
    }

    function test_A9_frozenToken_doesNotBlockTheOthers() public {
        _put(cash, 100 * unit);
        _put(address(frozenToken), 10 * unit);
        _put(address(falseToken), 20 * unit);
        _put(stock, 2 * unit);
        frozenToken.setFrozen(true);
        falseToken.setFrozen(true);

        // One at a time: the frozen ones fail loudly, the others leave.
        vm.startPrank(owner);
        vm.expectRevert(FreezableToken.Frozen.selector);
        vault.withdraw(address(frozenToken), 10 * unit);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(falseToken)));
        vault.withdraw(address(falseToken), 20 * unit);
        vault.withdraw(cash, 40 * unit);
        assertEq(_bal(cash, owner), funded - 60 * unit);

        // All at once: a revert and a `false` are both skipped, returned, and announced by an event each,
        // since a wallet cannot read a return value.
        vm.expectEmit(address(vault));
        emit IBasketVault.WithdrawSkipped(address(frozenToken));
        vm.expectEmit(address(vault));
        emit IBasketVault.WithdrawSkipped(address(falseToken));
        address[] memory skipped = vault.withdrawAll();
        vm.stopPrank();

        assertEq(skipped.length, 2);
        assertEq(skipped[0], address(frozenToken));
        assertEq(skipped[1], address(falseToken));
        assertEq(_bal(cash, owner), funded);
        assertEq(_bal(stock, owner), funded);
        assertEq(frozenToken.balanceOf(address(vault)), 10 * unit);
        assertEq(falseToken.balanceOf(address(vault)), 20 * unit);

        // Unfrozen later, they leave too.
        frozenToken.setFrozen(false);
        falseToken.setFrozen(false);
        vm.prank(owner);
        skipped = vault.withdrawAll();
        assertEq(skipped.length, 0);
        assertEq(frozenToken.balanceOf(owner), funded);
        assertEq(falseToken.balanceOf(owner), funded);
    }

    function test_A9_tokenWhoseBalanceReadReverts_isSkipped() public {
        _put(address(frozenToken), 10 * unit);
        _put(cash, 100 * unit);
        frozenToken.setBricked(true);

        vm.prank(owner);
        address[] memory skipped = vault.withdrawAll();

        assertEq(skipped.length, 1);
        assertEq(skipped[0], address(frozenToken));
        assertEq(_bal(cash, owner), funded);
    }

    /// A balance read that answers with nothing, or with fewer than 32 bytes, is not a balance. The vault
    /// must not send whatever happened to be in memory.
    function test_A9_tokenWhoseBalanceReadIsShortOrAbsent_isSkipped() public {
        ShortAnswerToken odd = new ShortAnswerToken(dec);
        odd.mint(owner, funded);
        _listAndApprove(address(odd));
        _put(address(odd), 10 * unit);
        _put(cash, 100 * unit);

        uint256[2] memory answers = [uint256(0), 31];
        for (uint256 i; i < answers.length; ++i) {
            odd.setShort(true, answers[i]);
            vm.prank(owner);
            address[] memory skipped = vault.withdrawAll();
            assertEq(skipped.length, 1);
            assertEq(skipped[0], address(odd));
        }
        odd.setShort(false, 0);
        assertEq(odd.balanceOf(address(vault)), 10 * unit, "not one unit moved");
        assertEq(_bal(cash, owner), funded, "the healthy token left on the first pass");

        vm.prank(owner);
        assertEq(vault.withdrawAll().length, 0);
        assertEq(odd.balanceOf(owner), funded);
    }

    /// A token whose code is gone answers every call with success and nothing. That is not a transfer.
    function test_A9_tokenWhoseCodeIsGone_isSkipped() public {
        _put(stock, 2 * unit);
        _put(cash, 100 * unit);
        vm.etch(stock, hex"");

        vm.prank(owner);
        address[] memory skipped = vault.withdrawAll();

        assertEq(skipped.length, 1);
        assertEq(skipped[0], stock);
        assertEq(_bal(cash, owner), funded);
    }

    /// The issuer has put the owner on the token's blocklist: that token stays until the issuer lifts it.
    /// There is no other way out by design; the rest leaves.
    function test_A9_ownerOnTheTokensBlocklist() public {
        StockLikeToken blocked = new StockLikeToken(dec);
        blocked.mint(owner, funded);
        _listAndApprove(address(blocked));
        _put(address(blocked), 3 * unit);
        _put(cash, 100 * unit);
        blocked.setFrozen(owner, true);

        vm.startPrank(owner);
        vm.expectRevert(StockLikeToken.Blocked.selector);
        vault.withdraw(address(blocked), 3 * unit);
        address[] memory skipped = vault.withdrawAll();
        vm.stopPrank();

        assertEq(skipped.length, 1);
        assertEq(skipped[0], address(blocked));
        assertEq(_bal(cash, owner), funded);
        assertEq(blocked.balanceOf(address(vault)), 3 * unit);
    }

    // ---- nothing outside the vault can block the way out (I4, for this slot's surface)

    function test_I4_withdraw_makesNoCallToTheConfig() public {
        _put(cash, 100 * unit);
        _put(stock, 2 * unit);

        vm.expectCall(address(factory), bytes(""), 0);
        vm.startPrank(owner);
        vault.withdraw(cash, 40 * unit);
        vault.withdrawAll();
        vm.stopPrank();
        assertEq(_bal(cash, owner), funded);
        assertEq(_bal(stock, owner), funded);
    }

    /// The config reverting, burning all its gas, or gone: deposits stop, the way out does not.
    function test_I4_withdraw_worksWhateverTheConfigDoes() public {
        _put(cash, 100 * unit);
        _put(stock, 2 * unit);
        bytes[3] memory broken = [bytes(hex"60006000fd"), hex"fe", hex""];

        vm.startPrank(owner);
        for (uint256 i; i < broken.length; ++i) {
            vm.etch(address(factory), broken[i]);
            vm.expectRevert(bytes(""));
            vault.deposit(1);
            vault.withdraw(cash, 10 * unit);
        }
        address[] memory skipped = vault.withdrawAll();
        vm.stopPrank();

        assertEq(skipped.length, 0);
        assertEq(_bal(cash, owner), funded);
        assertEq(_bal(stock, owner), funded);
    }

    // ---- one reentrancy guard over every state-changing function

    /// Only the owner gets past the owner check, so the re-entering caller here is an owner that is also a
    /// token with a transfer hook. Each of the three functions is tried as the outer call and as the inner.
    function test_reentrantCall_isRefused() public {
        HookToken hook = new HookToken(dec);
        BasketVault hookVault = _createVault(address(hook), keccak256("plan-hook"));
        _list(address(hook), dec);
        _setCash(address(hook));
        hook.mint(address(hook), 100 * unit);
        hook.act(address(hook), abi.encodeCall(HookToken.approve, (address(hookVault), type(uint256).max)));
        hook.act(address(hookVault), abi.encodeCall(BasketVault.deposit, (10 * unit)));
        _mint(cash, address(hookVault), 10 * unit);

        bytes[3] memory inner = [
            abi.encodeCall(BasketVault.withdraw, (cash, 10 * unit)),
            abi.encodeCall(BasketVault.withdrawAll, ()),
            abi.encodeCall(BasketVault.deposit, (0))
        ];
        bytes4 reentered = ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector;
        for (uint256 i; i < inner.length; ++i) {
            hook.setHook(address(hookVault), inner[i]);

            // Outer withdraw and outer deposit: the token's revert comes straight back.
            vm.expectRevert(reentered);
            hook.act(address(hookVault), abi.encodeCall(BasketVault.withdraw, (address(hook), 1)));
            vm.expectRevert(reentered);
            hook.act(address(hookVault), abi.encodeCall(BasketVault.deposit, (unit)));

            // Outer withdrawAll: the token's transfer fails on the guard, so the token is skipped.
            bytes memory ret = hook.act(address(hookVault), abi.encodeCall(BasketVault.withdrawAll, ()));
            address[] memory skipped = abi.decode(ret, (address[]));
            assertEq(skipped.length, 1);
            assertEq(skipped[0], address(hook));
        }
        assertEq(_bal(cash, address(hookVault)), 10 * unit, "no inner call ran");
        assertEq(hook.balanceOf(address(hookVault)), 10 * unit);
    }

    // ---- fuzz

    function testFuzz_depositThenWithdraw(uint8 which, uint256 deposited, uint256 withdrawn) public {
        address[4] memory wellBehaved = [cash, stock, address(falseToken), address(noReturnToken)];
        address token = wellBehaved[which % wellBehaved.length];
        deposited = bound(deposited, 0, funded);
        withdrawn = bound(withdrawn, 0, deposited);
        uint256 supply = ITestToken(token).totalSupply();
        _setCash(token);

        vm.startPrank(owner);
        vault.deposit(deposited);
        assertEq(_bal(token, address(vault)), deposited);
        assertEq(_bal(token, owner), funded - deposited);

        vault.withdraw(token, withdrawn);
        assertEq(_bal(token, address(vault)), deposited - withdrawn);
        assertEq(_bal(token, owner), funded - deposited + withdrawn);

        // One unit more than the vault holds never leaves.
        if (token == address(falseToken)) {
            vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, token));
        } else {
            vm.expectRevert(TokenBase.InsufficientBalance.selector);
        }
        vault.withdraw(token, deposited - withdrawn + 1);

        address[] memory skipped = vault.withdrawAll();
        vm.stopPrank();

        assertEq(skipped.length, 0);
        assertEq(_bal(token, address(vault)), 0);
        assertEq(_bal(token, owner), funded);
        assertEq(ITestToken(token).totalSupply(), supply);
    }

    /// I1: whatever a caller other than the owner sends, the vault's tokens and its owner do not move.
    function testFuzz_I1_strangerCannotMoveTokens(address caller, uint8 which, address token, uint256 amount) public {
        vm.assume(caller != owner);
        _put(cash, 100 * unit);
        _put(stock, 2 * unit);

        bytes[8] memory calls = [
            abi.encodeCall(BasketVault.withdraw, (cash, bound(amount, 0, 100 * unit))),
            abi.encodeCall(BasketVault.withdraw, (token, amount)),
            abi.encodeCall(BasketVault.withdrawAll, ()),
            abi.encodeCall(BasketVault.deposit, (amount)),
            abi.encodeCall(BasketVault.initialize, (caller, PLAN_ID)),
            abi.encodeWithSignature("deposit(address,uint256)", cash, amount),
            abi.encodeWithSignature("withdraw(address,uint256,address)", cash, amount, caller),
            abi.encodeWithSignature("withdrawAll(address)", caller)
        ];
        vm.prank(caller);
        (bool ok,) = address(vault).call(calls[which % calls.length]);

        assertFalse(ok);
        assertEq(vault.owner(), owner);
        assertEq(_bal(cash, address(vault)), 100 * unit);
        assertEq(_bal(stock, address(vault)), 2 * unit);
    }
}

contract BasketVault6Test is BasketVaultTest {
    function _decimals() internal pure override returns (uint8) {
        return 6;
    }
}

contract BasketVault8Test is BasketVaultTest {
    function _decimals() internal pure override returns (uint8) {
        return 8;
    }
}

contract BasketVault18Test is BasketVaultTest {
    function _decimals() internal pure override returns (uint8) {
        return 18;
    }
}
