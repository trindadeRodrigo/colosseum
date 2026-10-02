// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {VaultFixture} from "./helpers/VaultFixture.sol";
import {MockToken, NoReturnToken} from "./mocks/Tokens.sol";

interface IBalance {
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

/// Drives one vault with an owner, strangers and a donor, and records any token that left the vault other
/// than by the owner's call and to the owner.
contract VaultHandler is Test {
    BasketVault internal vault;
    address internal owner;
    address[] internal tokens;
    address[] internal strangers;

    /// Set when a token left the vault by a call that was not the owner's, or went anywhere but the owner.
    bool public leaked;
    uint256 public deposits;
    uint256 public withdrawals;
    uint256 public sweeps;
    uint256 public strangerCalls;
    uint256 public donations;

    constructor(BasketVault vault_, address owner_, address[] memory tokens_, address[] memory strangers_) {
        vault = vault_;
        owner = owner_;
        tokens = tokens_;
        strangers = strangers_;
    }

    modifier watched(address caller) {
        uint256 n = tokens.length;
        uint256[] memory vaultBefore = new uint256[](n);
        uint256[] memory ownerBefore = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            vaultBefore[i] = IBalance(tokens[i]).balanceOf(address(vault));
            ownerBefore[i] = IBalance(tokens[i]).balanceOf(owner);
        }
        _;
        for (uint256 i; i < n; ++i) {
            uint256 vaultAfter = IBalance(tokens[i]).balanceOf(address(vault));
            if (vaultAfter >= vaultBefore[i]) continue;
            uint256 left = vaultBefore[i] - vaultAfter;
            if (caller != owner || IBalance(tokens[i]).balanceOf(owner) != ownerBefore[i] + left) leaked = true;
        }
    }

    function ownerDeposit(uint256 tokenSeed, uint256 amount) external watched(owner) {
        address token = tokens[tokenSeed % tokens.length];
        amount = bound(amount, 0, IBalance(token).balanceOf(owner));
        vm.prank(owner);
        vault.deposit(token, amount);
        ++deposits;
    }

    function ownerWithdraw(uint256 tokenSeed, uint256 amount) external watched(owner) {
        address token = tokens[tokenSeed % tokens.length];
        amount = bound(amount, 0, IBalance(token).balanceOf(address(vault)));
        vm.prank(owner);
        vault.withdraw(token, amount);
        ++withdrawals;
    }

    function ownerWithdrawAll() external watched(owner) {
        vm.prank(owner);
        address[] memory skipped = vault.withdrawAll();
        assertEq(skipped.length, 0);
        ++sweeps;
    }

    /// A stranger tries every entry point, including the recipient-taking shapes the rig had.
    function strangerCall(uint256 strangerSeed, uint256 callSeed, uint256 tokenSeed, uint256 amount) external {
        address caller = strangers[strangerSeed % strangers.length];
        _strangerCall(caller, callSeed, tokens[tokenSeed % tokens.length], amount);
    }

    function _strangerCall(address caller, uint256 callSeed, address token, uint256 amount) internal watched(caller) {
        amount = bound(amount, 0, IBalance(token).balanceOf(address(vault)));
        bytes[6] memory calls = [
            abi.encodeCall(BasketVault.withdraw, (token, amount)),
            abi.encodeCall(BasketVault.withdrawAll, ()),
            abi.encodeCall(BasketVault.deposit, (token, amount)),
            abi.encodeCall(BasketVault.initialize, (caller, bytes32(0), vault.config())),
            abi.encodeWithSignature("withdraw(address,uint256,address)", token, amount, caller),
            abi.encodeWithSignature("withdrawAll(address)", caller)
        ];
        vm.prank(caller);
        (bool ok,) = address(vault).call(calls[callSeed % calls.length]);
        assertFalse(ok, "a stranger's call went through");
        ++strangerCalls;
    }

    /// Tokens arriving from outside (A10's shape) are the owner's to withdraw and nobody else's.
    function donate(uint256 tokenSeed, uint256 amount) external {
        address token = tokens[tokenSeed % tokens.length];
        MockToken(token).mint(address(vault), bound(amount, 0, 1e30));
        ++donations;
    }
}

/// I1: tokens leave a vault only by the owner's call, and only to the owner.
contract BasketVaultInvariantTest is VaultFixture {
    VaultHandler internal handler;
    address[] internal tokens;
    address[] internal strangers;

    function setUp() public {
        _deployPlatform();
        tokens.push(address(new MockToken(6)));
        tokens.push(address(new MockToken(18)));
        tokens.push(address(new NoReturnToken(8)));
        strangers.push(stranger);
        strangers.push(admin);
        strangers.push(makeAddr("keeper"));

        uint8[3] memory decimals = [6, 18, 8];
        for (uint256 i; i < tokens.length; ++i) {
            _list(tokens[i], decimals[i]);
            MockToken(tokens[i]).mint(owner, 1e30);
            vm.prank(owner);
            NoReturnToken(tokens[i]).approve(address(vault), type(uint256).max);
            // A stranger with tokens and an allowance still cannot get in or out.
            MockToken(tokens[i]).mint(stranger, 1e30);
            vm.prank(stranger);
            NoReturnToken(tokens[i]).approve(address(vault), type(uint256).max);
        }

        handler = new VaultHandler(vault, owner, tokens, strangers);
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = VaultHandler.ownerDeposit.selector;
        selectors[1] = VaultHandler.ownerWithdraw.selector;
        selectors[2] = VaultHandler.ownerWithdrawAll.selector;
        selectors[3] = VaultHandler.strangerCall.selector;
        selectors[4] = VaultHandler.donate.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_I1_tokensLeaveOnlyByTheOwnerAndToTheOwner() public view {
        assertFalse(handler.leaked(), "a token left the vault by another way");
        assertEq(vault.owner(), owner);
        for (uint256 i; i < tokens.length; ++i) {
            IBalance token = IBalance(tokens[i]);
            // Every unit is with the owner, in the vault, or still with the stranger who never got in.
            assertEq(token.balanceOf(stranger), 1e30);
            assertEq(token.balanceOf(admin), 0);
            assertEq(token.balanceOf(owner) + token.balanceOf(address(vault)) + 1e30, token.totalSupply());
        }
    }

    /// A run where nothing happened would prove nothing. With `fail-on-revert` on, every counted call went
    /// through as the handler meant it to: the owner's succeeded and the strangers' were refused.
    function afterInvariant() public view {
        assertGt(handler.deposits(), 0);
        assertGt(handler.withdrawals(), 0);
        assertGt(handler.sweeps(), 0);
        assertGt(handler.strangerCalls(), 0);
        assertGt(handler.donations(), 0);
    }
}
