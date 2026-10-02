// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

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
        vm.startPrank(owner);
        cash.approve(address(vault), type(uint256).max);
        vault.deposit(address(cash), 100e6);
        vm.stopPrank();
    }

    /// A15: the admin key swaps the logic for every vault in one transaction. State stays, withdraw works,
    /// and `initialize` stays shut on the new logic contract and on the live proxy.
    function test_A15_beaconUpgrade_keepsStateAndWithdraws() public {
        BasketVaultV2Dummy v2 = new BasketVaultV2Dummy();
        vm.prank(admin);
        beacon.upgradeTo(address(v2));

        assertEq(BasketVaultV2Dummy(address(vault)).version(), 2);
        assertEq(vault.owner(), owner);
        assertEq(vault.planId(), PLAN_ID);
        assertEq(vault.config(), address(config));
        address[] memory tracked = vault.tokens();
        assertEq(tracked.length, 1);
        assertEq(tracked[0], address(cash));
        assertEq(cash.balanceOf(address(vault)), 100e6);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(stranger, PLAN_ID, address(config));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        v2.initialize(stranger, PLAN_ID, address(config));

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

    /// The vault keeps its state in one ERC-7201 namespace. Later slots append to the struct; these three
    /// fields stay where they are.
    function test_storage_isTheErc7201Namespace() public view {
        bytes32 slot =
            keccak256(abi.encode(uint256(keccak256("basket.storage.BasketVault")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(address(uint160(uint256(vm.load(address(vault), slot)))), owner);
        assertEq(address(uint160(uint256(vm.load(address(vault), bytes32(uint256(slot) + 1))))), address(config));
        assertEq(vm.load(address(vault), bytes32(uint256(slot) + 2)), PLAN_ID);
        // Nothing sits in the plain slots a later base contract could collide with.
        for (uint256 i; i < 8; ++i) {
            assertEq(vm.load(address(vault), bytes32(i)), bytes32(0));
        }
    }

    /// I1, stated as the whole surface: these are all the vault's entry points, and none takes a recipient.
    /// A slot that adds one updates this list, and with it looks at what the new function can move.
    function test_I1_entryPoints_areExactlyThese() public view {
        string[8] memory expected = [
            "initialize(address,bytes32,address)",
            "deposit(address,uint256)",
            "withdraw(address,uint256)",
            "withdrawAll()",
            "owner()",
            "planId()",
            "config()",
            "tokens()"
        ];
        string memory artifact = vm.readFile("out/BasketVault.sol/BasketVault.json");
        string[] memory found = vm.parseJsonKeys(artifact, ".methodIdentifiers");
        assertEq(found.length, expected.length, "an entry point was added or removed");
        for (uint256 i; i < expected.length; ++i) {
            bool present;
            for (uint256 j; j < found.length; ++j) {
                if (keccak256(bytes(found[j])) == keccak256(bytes(expected[i]))) present = true;
            }
            assertTrue(present, expected[i]);
        }
    }

    function test_selectors_matchSection38() public pure {
        assertEq(BasketVault.deposit.selector, IBasketVault.deposit.selector);
        assertEq(BasketVault.withdraw.selector, IBasketVault.withdraw.selector);
        assertEq(BasketVault.withdrawAll.selector, IBasketVault.withdrawAll.selector);
    }
}
