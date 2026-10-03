// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {IBasketVault} from "../src/interfaces/IBasketVault.sol";
import {VaultFixture} from "./helpers/VaultFixture.sol";
import {MockToken} from "./mocks/Tokens.sol";

/// A stand-in for the next version of the vault logic: the same contract with one more function.
contract BasketVaultV2Dummy is BasketVault {
    function version() external pure returns (uint256) {
        return 2;
    }
}

/// The vault as a beacon proxy: the storage it uses, the upgrade path, and the names it shares with 3.8.
contract BasketVaultProxyTest is VaultFixture {
    MockToken internal cash;

    function setUp() public {
        _deployPlatform();
        cash = new MockToken(6);
        _list(address(cash), 6);
        cash.mint(owner, 100e6);
        _setCash(address(cash));
        vm.startPrank(owner);
        cash.approve(address(vault), type(uint256).max);
        vault.deposit(100e6);
        vm.stopPrank();
    }

    /// A15: the admin key swaps the logic for every vault in one transaction. State stays, withdraw works,
    /// and `initialize` stays shut on the new logic contract and on the live proxy.
    function test_A15_beaconUpgrade_keepsStateAndWithdraws() public {
        BasketVaultV2Dummy v2 = new BasketVaultV2Dummy();
        vm.prank(admin);
        beacon.upgradeTo(address(v2));

        assertEq(BasketVaultV2Dummy(payable(address(vault))).version(), 2);
        assertEq(vault.owner(), owner);
        assertEq(vault.planId(), PLAN_ID);
        assertEq(vault.config(), address(factory));
        address[] memory tracked = vault.tokens();
        assertEq(tracked.length, 1);
        assertEq(tracked[0], address(cash));
        assertEq(cash.balanceOf(address(vault)), 100e6);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(stranger, PLAN_ID);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        v2.initialize(stranger, PLAN_ID);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, stranger));
        vault.withdraw(address(cash), 1);

        vm.prank(owner);
        vault.withdraw(address(cash), 100e6);
        assertEq(cash.balanceOf(owner), 100e6);
    }

    function test_beaconUpgrade_revertsForAnyoneButTheBeaconOwner() public {
        BasketVaultV2Dummy v2 = new BasketVaultV2Dummy();
        address[2] memory callers = [stranger, owner];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            beacon.upgradeTo(address(v2));
        }
        assertEq(beacon.implementation(), address(logic));
        assertEq(beacon.owner(), admin);
    }

    /// I1 from outside: a call no function matches, and plain ether, are both turned away. The full list of
    /// entry points is pinned in `EntryPoints.t.sol`.
    function test_I1_unknownCallsAndEther_areRefused() public {
        vm.deal(owner, 1 ether);
        vm.startPrank(owner);
        (bool ok,) = address(vault).call(abi.encodeWithSignature("sweep(address)", owner));
        assertFalse(ok);
        (ok,) = address(vault).call{value: 1 wei}("");
        assertFalse(ok);
        (ok,) = address(vault).call("");
        assertFalse(ok);
        vm.stopPrank();
    }

    /// The vault does not inherit `IBasketVault` until it implements all of it, so the compiler does not hold
    /// the two to each other. This does, for everything built so far.
    function test_selectors_matchSection38() public pure {
        assertEq(BasketVault.initialize.selector, IBasketVault.initialize.selector);
        assertEq(BasketVault.start.selector, IBasketVault.start.selector);
        assertEq(BasketVault.deposit.selector, IBasketVault.deposit.selector);
        assertEq(BasketVault.withdraw.selector, IBasketVault.withdraw.selector);
        assertEq(BasketVault.withdrawAll.selector, IBasketVault.withdrawAll.selector);
        assertEq(BasketVault.ownerSwap.selector, IBasketVault.ownerSwap.selector);
        assertEq(BasketVault.setTargets.selector, IBasketVault.setTargets.selector);
        assertEq(bytes4(keccak256("multicall(bytes[])")), IBasketVault.multicall.selector);
        assertEq(BasketVault.owner.selector, IBasketVault.owner.selector);
        assertEq(BasketVault.planId.selector, IBasketVault.planId.selector);
        assertEq(BasketVault.config.selector, IBasketVault.config.selector);
        assertEq(BasketVault.tokens.selector, IBasketVault.tokens.selector);
        assertEq(BasketVault.targets.selector, IBasketVault.targets.selector);
        assertEq(BasketVault.following.selector, IBasketVault.following.selector);
    }
}
