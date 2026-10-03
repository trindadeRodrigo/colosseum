// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {VaultFixture} from "./helpers/VaultFixture.sol";
import {MockToken, NoReturnToken} from "./mocks/Tokens.sol";

interface IBalance {
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

/// Drives one vault with its owner, a donor, and callers that are not the owner, and records any token that
/// left the vault other than by the owner's call and to the owner.
contract VaultHandler is Test {
    BasketVault internal vault;
    VaultFactory internal factory;
    address internal owner;
    address internal admin;
    address[] internal tokens;
    /// The addresses a hostile call is most likely to come from: the config, the beacon, the logic contract,
    /// the admin, a funded stranger, the vault itself. Any other address is tried too.
    address[] internal insiders;

    /// Set when a token left the vault by a call that was not the owner's, or went anywhere but the owner.
    bool public leaked;
    uint256 public deposits;
    uint256 public withdrawals;
    uint256 public sweeps;
    uint256 public namedCalls;
    uint256 public rawCalls;
    uint256 public donations;

    constructor(
        BasketVault vault_,
        VaultFactory factory_,
        address owner_,
        address admin_,
        address[] memory tokens_,
        address[] memory insiders_
    ) {
        vault = vault_;
        factory = factory_;
        owner = owner_;
        admin = admin_;
        tokens = tokens_;
        insiders = insiders_;
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

    /// The owner deposits whichever token is the cash token at that moment.
    function ownerDeposit(uint256 tokenSeed, uint256 amount) external watched(owner) {
        address token = tokens[tokenSeed % tokens.length];
        amount = bound(amount, 0, IBalance(token).balanceOf(owner));
        vm.prank(admin);
        factory.setCashToken(token);
        vm.prank(owner);
        vault.deposit(amount);
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

    /// Anyone but the owner tries each entry point by name, and the recipient-taking shapes the rig had.
    /// Every one of them must fail.
    function strangerNamedCall(uint256 callerSeed, address anyone, uint256 callSeed, uint256 tokenSeed, uint256 amount)
        external
    {
        address caller = _notTheOwner(callerSeed, anyone);
        address token = tokens[tokenSeed % tokens.length];
        amount = bound(amount, 0, IBalance(token).balanceOf(address(vault)));
        bytes[7] memory calls = [
            abi.encodeCall(BasketVault.withdraw, (token, amount)),
            abi.encodeCall(BasketVault.withdrawAll, ()),
            abi.encodeCall(BasketVault.deposit, (amount)),
            abi.encodeCall(BasketVault.initialize, (caller, bytes32(0))),
            abi.encodeWithSignature("deposit(address,uint256)", token, amount),
            abi.encodeWithSignature("withdraw(address,uint256,address)", token, amount, caller),
            abi.encodeWithSignature("withdrawAll(address)", caller)
        ];
        bool ok = _callAs(caller, calls[callSeed % calls.length]);
        assertFalse(ok, "a call that was not the owner's went through");
        ++namedCalls;
    }

    /// Anyone but the owner sends raw bytes: a known selector with fuzzed arguments, or fuzzed bytes alone.
    /// A view may answer; nothing may move.
    function strangerRawCall(uint256 callerSeed, address anyone, uint256 selectorSeed, bytes calldata data) external {
        address caller = _notTheOwner(callerSeed, anyone);
        bytes4[8] memory selectors = [
            BasketVault.withdraw.selector,
            BasketVault.withdrawAll.selector,
            BasketVault.deposit.selector,
            BasketVault.initialize.selector,
            BasketVault.owner.selector,
            BasketVault.tokens.selector,
            bytes4(0),
            bytes4(0)
        ];
        bytes4 selector = selectors[selectorSeed % selectors.length];
        address ownerBefore = vault.owner();
        address configBefore = vault.config();
        uint256 listBefore = vault.tokens().length;

        _callAs(caller, selector == bytes4(0) ? data : bytes.concat(selector, data));

        assertEq(vault.owner(), ownerBefore);
        assertEq(vault.config(), configBefore);
        assertEq(vault.tokens().length, listBefore);
        ++rawCalls;
    }

    /// Tokens arriving from outside (A10's shape) are the owner's to withdraw and nobody else's.
    function donate(uint256 tokenSeed, uint256 amount) external {
        address token = tokens[tokenSeed % tokens.length];
        MockToken(token).mint(address(vault), bound(amount, 0, 1e30));
        ++donations;
    }

    function _callAs(address caller, bytes memory data) internal watched(caller) returns (bool ok) {
        vm.prank(caller);
        (ok,) = address(vault).call(data);
    }

    function _notTheOwner(uint256 callerSeed, address anyone) internal view returns (address) {
        uint256 pick = callerSeed % (insiders.length + 1);
        address caller = pick < insiders.length ? insiders[pick] : anyone;
        return caller == owner ? insiders[0] : caller;
    }
}

/// I1: tokens leave a vault only by the owner's call, and only to the owner.
contract BasketVaultInvariantTest is VaultFixture {
    VaultHandler internal handler;
    address[] internal tokens;
    address[] internal insiders;

    function setUp() public {
        _deployPlatform();
        tokens.push(address(new MockToken(6)));
        tokens.push(address(new MockToken(18)));
        tokens.push(address(new NoReturnToken(8)));
        insiders.push(address(factory));
        insiders.push(address(beacon));
        insiders.push(address(logic));
        insiders.push(admin);
        insiders.push(stranger);
        insiders.push(address(vault));

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

        handler = new VaultHandler(vault, factory, owner, admin, tokens, insiders);
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = VaultHandler.ownerDeposit.selector;
        selectors[1] = VaultHandler.ownerWithdraw.selector;
        selectors[2] = VaultHandler.ownerWithdrawAll.selector;
        selectors[3] = VaultHandler.strangerNamedCall.selector;
        selectors[4] = VaultHandler.strangerRawCall.selector;
        selectors[5] = VaultHandler.donate.selector;
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
            for (uint256 j; j < insiders.length; ++j) {
                if (insiders[j] != stranger && insiders[j] != address(vault)) {
                    assertEq(token.balanceOf(insiders[j]), 0);
                }
            }
            assertEq(token.balanceOf(owner) + token.balanceOf(address(vault)) + 1e30, token.totalSupply());
        }
    }

    /// A run where nothing happened would prove nothing. With `fail-on-revert` on, every counted call went
    /// through as the handler meant it to: the owner's succeeded and the others' were refused.
    function afterInvariant() public view {
        assertGt(handler.deposits(), 0);
        assertGt(handler.withdrawals(), 0);
        assertGt(handler.sweeps(), 0);
        assertGt(handler.namedCalls(), 0);
        assertGt(handler.rawCalls(), 0);
        assertGt(handler.donations(), 0);
    }
}
