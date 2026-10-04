// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {VaultBeacon} from "../src/VaultBeacon.sol";
import {VaultFixture} from "./helpers/VaultFixture.sol";

/// The beacon's key replaces the logic of every vault. It changes hands in two steps and cannot be given up.
contract VaultBeaconTest is VaultFixture {
    address internal next = makeAddr("next-owner");
    BasketVault internal v2;

    function setUp() public {
        _deployPlatform();
        v2 = new BasketVault();
    }

    function test_handover_takesTwoSteps() public {
        vm.prank(admin);
        beacon.transferOwnership(next);
        assertEq(beacon.owner(), admin, "nothing moves until the new owner accepts");
        assertEq(beacon.pendingOwner(), next);

        // Until then the proposed owner has no power and the old one keeps it.
        vm.prank(next);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, next));
        beacon.upgradeTo(address(v2));
        assertEq(beacon.implementation(), address(logic));

        vm.prank(next);
        beacon.acceptOwnership();
        assertEq(beacon.owner(), next);
        assertEq(beacon.pendingOwner(), address(0));

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        beacon.upgradeTo(address(v2));
        vm.prank(next);
        beacon.upgradeTo(address(v2));
        assertEq(beacon.implementation(), address(v2));
    }

    /// A mistyped address never accepts, so the key stays where it was and the proposal can be replaced.
    function test_handover_onlyTheProposedOwnerAccepts() public {
        vm.prank(admin);
        beacon.transferOwnership(next);
        address[2] memory callers = [stranger, admin];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            beacon.acceptOwnership();
        }
        assertEq(beacon.owner(), admin);

        vm.prank(admin);
        beacon.transferOwnership(address(0));
        vm.prank(next);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, next));
        beacon.acceptOwnership();
    }

    function test_transferOwnership_revertsForAnyoneButTheOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        beacon.transferOwnership(stranger);
        assertEq(beacon.pendingOwner(), address(0));
    }

    /// With no owner, no vault could ever be fixed.
    function test_renounceOwnership_alwaysReverts() public {
        vm.prank(admin);
        vm.expectRevert(VaultBeacon.RenounceDisabled.selector);
        beacon.renounceOwnership();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        beacon.renounceOwnership();
        assertEq(beacon.owner(), admin);
    }

    function test_upgradeTo_revertsOnAnAddressWithNoCode() public {
        address empty = makeAddr("no-code");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(UpgradeableBeacon.BeaconInvalidImplementation.selector, empty));
        beacon.upgradeTo(empty);
        assertEq(beacon.implementation(), address(logic));
    }
}
