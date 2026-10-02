// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {IBasketVault} from "../src/interfaces/IBasketVault.sol";
import {VaultFixture} from "./helpers/VaultFixture.sol";
import {FalseReturnToken, FeeToken, FreezableToken, HookToken, MockToken, NoReturnToken} from "./mocks/Tokens.sol";

interface ITestToken {
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(address spender, uint256 amount) external;
}

/// The owner path of the vault: deposit, and withdraw in kind to the owner only. Every test runs at 6, 8
/// and 18 decimals through the three contracts at the end of this file.
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

        address[6] memory all = _allTokens();
        for (uint256 i; i < all.length; ++i) {
            _list(all[i], dec);
            vm.prank(owner);
            ITestToken(all[i]).approve(address(vault), type(uint256).max);
        }
    }

    function _allTokens() internal view returns (address[6] memory) {
        return [cash, stock, address(falseToken), address(noReturnToken), address(feeToken), address(frozenToken)];
    }

    function _bal(address token, address who) internal view returns (uint256) {
        return ITestToken(token).balanceOf(who);
    }

    function _deposit(address token, uint256 amount) internal {
        vm.prank(owner);
        vault.deposit(token, amount);
    }

    // ---- initialise

    function test_initialize_setsOwnerPlanAndConfig() public view {
        assertEq(vault.owner(), owner);
        assertEq(vault.planId(), PLAN_ID);
        assertEq(vault.config(), address(config));
        assertEq(vault.tokens().length, 0);
    }

    function test_initialize_revertsOnZeroOwner() public {
        vm.expectRevert(IBasketVault.ZeroAddress.selector);
        _createVault(address(0), PLAN_ID);
    }

    function test_initialize_revertsOnZeroConfig() public {
        vm.expectRevert(IBasketVault.ZeroAddress.selector);
        _createVault(owner, PLAN_ID, address(0));
    }

    function test_A15_initialize_revertsOnLiveProxy() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(stranger, PLAN_ID, address(config));

        vm.prank(owner);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(stranger, PLAN_ID, address(config));

        assertEq(vault.owner(), owner);
    }

    function test_A15_initialize_revertsOnLogicContract() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        logic.initialize(stranger, PLAN_ID, address(config));
        assertEq(logic.owner(), address(0));
    }

    // ---- deposit

    function test_deposit_movesExactAmountAndTracksToken() public {
        _deposit(cash, 100 * unit);
        assertEq(_bal(cash, address(vault)), 100 * unit);
        assertEq(_bal(cash, owner), funded - 100 * unit);

        _deposit(stock, 3 * unit);
        _deposit(cash, 1);
        address[] memory tracked = vault.tokens();
        assertEq(tracked.length, 2, "one entry per token");
        assertEq(tracked[0], cash);
        assertEq(tracked[1], stock);
        assertEq(_bal(cash, address(vault)), 100 * unit + 1);
    }

    function test_deposit_revertsForStranger() public {
        _mint(cash, stranger, 10 * unit);
        vm.startPrank(stranger);
        ITestToken(cash).approve(address(vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, stranger));
        vault.deposit(cash, 10 * unit);
        vm.stopPrank();
        assertEq(_bal(cash, address(vault)), 0);
    }

    function test_deposit_revertsForUnlistedToken() public {
        address unlisted = _newToken(dec);
        _mint(unlisted, owner, 10 * unit);
        vm.startPrank(owner);
        ITestToken(unlisted).approve(address(vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.AssetNotListed.selector, unlisted));
        vault.deposit(unlisted, 10 * unit);
        vm.stopPrank();
    }

    function test_deposit_tokenReturningFalse() public {
        _deposit(address(falseToken), 50 * unit);
        assertEq(falseToken.balanceOf(address(vault)), 50 * unit);

        // No allowance left: the token answers `false` and moves nothing. The vault must not count it.
        vm.startPrank(owner);
        falseToken.approve(address(vault), 0);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(falseToken)));
        vault.deposit(address(falseToken), 50 * unit);
        vm.stopPrank();
        assertEq(falseToken.balanceOf(address(vault)), 50 * unit);
    }

    function test_deposit_tokenReturningNothing() public {
        _deposit(address(noReturnToken), 50 * unit);
        assertEq(noReturnToken.balanceOf(address(vault)), 50 * unit);
        assertEq(noReturnToken.balanceOf(owner), funded - 50 * unit);
    }

    function test_deposit_feeOnTransferToken_isRejected() public {
        feeToken.setFeeBps(100);
        uint256 amount = 200 * unit;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                IBasketVault.DepositShortfall.selector, address(feeToken), amount, amount - amount / 100
            )
        );
        vault.deposit(address(feeToken), amount);
        assertEq(feeToken.balanceOf(address(vault)), 0);
        assertEq(feeToken.balanceOf(owner), funded);
    }

    // ---- withdraw

    function test_withdraw_paysTheOwner() public {
        _deposit(cash, 100 * unit);
        vm.prank(owner);
        vault.withdraw(cash, 40 * unit);
        assertEq(_bal(cash, address(vault)), 60 * unit);
        assertEq(_bal(cash, owner), funded - 60 * unit);
    }

    function test_I1_withdraw_revertsForAnyoneButTheOwner() public {
        _deposit(cash, 100 * unit);
        address[5] memory callers = [stranger, admin, address(config), address(beacon), address(vault)];
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
        _deposit(cash, 100 * unit);
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
        _deposit(address(falseToken), 50 * unit);
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
        _deposit(address(noReturnToken), 50 * unit);
        vm.prank(owner);
        vault.withdraw(address(noReturnToken), 20 * unit);
        assertEq(noReturnToken.balanceOf(address(vault)), 30 * unit);
        assertEq(noReturnToken.balanceOf(owner), funded - 30 * unit);
    }

    /// A token that starts skimming after the deposit can still leave. The owner receives what the token delivers.
    function test_withdraw_feeSwitchedOnAfterDeposit() public {
        _deposit(address(feeToken), 100 * unit);
        feeToken.setFeeBps(100);
        vm.prank(owner);
        vault.withdraw(address(feeToken), 100 * unit);
        assertEq(feeToken.balanceOf(address(vault)), 0);
        assertEq(feeToken.balanceOf(owner), funded - unit);
    }

    /// A10's shape: a balance that arrived from outside, in a token the platform never listed.
    function test_A10_withdraw_tokenSentFromOutside() public {
        address unlisted = _newToken(dec);
        _mint(unlisted, address(vault), 7 * unit);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, stranger));
        vault.withdraw(unlisted, 7 * unit);

        vm.prank(owner);
        vault.withdraw(unlisted, 7 * unit);
        assertEq(_bal(unlisted, owner), 7 * unit);
    }

    // ---- withdrawAll and a frozen token (A9)

    function test_withdrawAll_sendsEverythingToTheOwner() public {
        _deposit(cash, 100 * unit);
        _deposit(stock, 2 * unit);
        _deposit(address(noReturnToken), 5 * unit);
        _deposit(address(falseToken), 6 * unit);
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
        _deposit(cash, 100 * unit);
        _deposit(address(frozenToken), 10 * unit);
        _deposit(address(falseToken), 20 * unit);
        _deposit(stock, 2 * unit);
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

        // All at once: a revert and a `false` are both skipped and reported.
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
        _deposit(address(frozenToken), 10 * unit);
        _deposit(cash, 100 * unit);
        frozenToken.setBricked(true);

        vm.prank(owner);
        address[] memory skipped = vault.withdrawAll();

        assertEq(skipped.length, 1);
        assertEq(skipped[0], address(frozenToken));
        assertEq(_bal(cash, owner), funded);
    }

    // ---- nothing outside the vault can block the way out (I4, for this slot's surface)

    function test_I4_withdraw_worksWhileTheConfigReverts() public {
        _deposit(cash, 100 * unit);
        _deposit(stock, 2 * unit);
        vm.etch(address(config), hex"60006000fd");

        vm.startPrank(owner);
        vm.expectRevert();
        vault.deposit(cash, 1);

        vault.withdraw(cash, 30 * unit);
        address[] memory skipped = vault.withdrawAll();
        vm.stopPrank();

        assertEq(skipped.length, 0);
        assertEq(_bal(cash, owner), funded);
        assertEq(_bal(stock, owner), funded);
    }

    // ---- one reentrancy guard over every state-changing function

    /// Only the owner gets past the owner check, so the re-entering caller here is an owner that is also a
    /// token with a transfer hook.
    function test_reentrantCall_isRefused() public {
        HookToken hook = new HookToken(dec);
        BasketVault hookVault = _createVault(address(hook), keccak256("plan-hook"));
        hook.mint(address(hookVault), 10 * unit);
        _mint(cash, address(hookVault), 10 * unit);

        bytes[3] memory inner = [
            abi.encodeCall(BasketVault.withdraw, (cash, 10 * unit)),
            abi.encodeCall(BasketVault.withdrawAll, ()),
            abi.encodeCall(BasketVault.deposit, (cash, 0))
        ];
        for (uint256 i; i < inner.length; ++i) {
            hook.setHook(address(hookVault), inner[i]);
            vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
            hook.act(address(hookVault), abi.encodeCall(BasketVault.withdraw, (address(hook), 1)));
        }
        assertEq(_bal(cash, address(hookVault)), 10 * unit);
    }

    // ---- fuzz

    function testFuzz_depositThenWithdraw(uint8 which, uint256 deposited, uint256 withdrawn) public {
        address[4] memory wellBehaved = [cash, stock, address(falseToken), address(noReturnToken)];
        address token = wellBehaved[which % wellBehaved.length];
        deposited = bound(deposited, 0, funded);
        withdrawn = bound(withdrawn, 0, deposited);
        uint256 supply = ITestToken(token).totalSupply();

        vm.startPrank(owner);
        vault.deposit(token, deposited);
        assertEq(_bal(token, address(vault)), deposited);
        assertEq(_bal(token, owner), funded - deposited);

        vault.withdraw(token, withdrawn);
        assertEq(_bal(token, address(vault)), deposited - withdrawn);
        assertEq(_bal(token, owner), funded - deposited + withdrawn);

        // One unit more than the vault holds never leaves.
        vm.expectRevert();
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
        _deposit(cash, 100 * unit);
        _deposit(stock, 2 * unit);

        bytes[7] memory calls = [
            abi.encodeCall(BasketVault.withdraw, (cash, bound(amount, 0, 100 * unit))),
            abi.encodeCall(BasketVault.withdraw, (token, amount)),
            abi.encodeCall(BasketVault.withdrawAll, ()),
            abi.encodeCall(BasketVault.deposit, (cash, amount)),
            abi.encodeCall(BasketVault.initialize, (caller, PLAN_ID, address(config))),
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
