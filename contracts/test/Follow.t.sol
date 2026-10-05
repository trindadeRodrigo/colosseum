// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {BasketVault} from "../src/BasketVault.sol";
import {IBasketVault} from "../src/interfaces/IBasketVault.sol";
import {Swap, Weight} from "../src/interfaces/Types.sol";
import {KeeperFixture} from "./helpers/KeeperFixture.sol";
import {BackdoorToken} from "./mocks/Tokens.sol";

/// Following a shared portfolio: the owner's accept, the auto-follow switch, and the adopt anyone may call
/// for a vault that follows (DESIGN-VAULT.md sections 3.7 and 5, "New versions"). A14 and A18.
contract FollowTest is KeeperFixture {
    bytes32 internal constant FAMILY = keccak256("family");
    bytes32 internal constant META = keccak256("meta");
    address internal creator = makeAddr("creator");
    bytes32 internal id;

    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function setUp() public {
        _deployKeeperPlatform();
        vm.prank(creator);
        id = registry.create(FAMILY, _threeStocks(), META, 0, 0);
        // One version per publish delay: the next may be published from here.
        vm.warp(block.timestamp + PUBLISH_DELAY);
        _refresh();
    }

    /// Three weights over the three stocks, sorted by token.
    function _weights(uint16 a, uint16 b, uint16 c) internal view returns (Weight[] memory list) {
        list = new Weight[](3);
        list[0] = Weight(address(stockA), a);
        list[1] = Weight(address(stockB), b);
        list[2] = Weight(address(stockC), c);
        return _sort(list);
    }

    function _publish(Weight[] memory next) internal returns (uint32 version) {
        vm.prank(creator);
        (version,) = registry.publish(id, next, META);
    }

    function _accept(uint32 version) internal {
        vm.prank(owner);
        vault.acceptVersion(id, version);
    }

    /// The vault's target for `token`, and whether it has one.
    function _targetOf(address token) internal view returns (bool found, uint16 bps) {
        Weight[] memory list = vault.targets();
        for (uint256 i; i < list.length; ++i) {
            if (list[i].token == token) return (true, list[i].bps);
        }
    }

    function _assertTargets(Weight[] memory expected) internal view {
        Weight[] memory list = vault.targets();
        assertEq(list.length, expected.length, "how many targets");
        for (uint256 i; i < list.length; ++i) {
            assertEq(list[i].token, expected[i].token, "the token of a target");
            assertEq(list[i].bps, expected[i].bps, "the weight of a target");
        }
    }

    function _ownerBuys(address token, uint256 cashAmount) internal {
        Swap memory s = _swap(direct, address(cash), token, cashAmount, _amountFor(token, cashAmount));
        vm.prank(owner);
        vault.ownerSwap(_swaps(s), LATER);
    }

    // ---- accept

    function test_acceptVersion_takesTheVersionInEffect() public {
        vm.expectEmit(address(vault));
        emit IBasketVault.Followed(address(vault), id, 1);
        _accept(1);
        _assertTargets(_threeStocks());
        (bytes32 followed, uint32 version, bool autoFollow) = vault.following();
        assertEq(followed, id);
        assertEq(version, 1);
        assertTrue(autoFollow, "auto-follow is left as it was");
    }

    /// A18: an accept signed against version 1 that lands after version 2 took effect.
    function test_A18_anAcceptSignedAgainstAnOlderVersion_isRefused() public {
        _publish(_weights(4000, 4000, 2000));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.VersionMismatch.selector, id, 1, 2));
        vault.acceptVersion(id, 1);
        _accept(2);
    }

    /// The number of the version that waits is not in effect yet.
    function test_acceptVersion_ofTheVersionThatWaits_isRefused() public {
        uint32 waiting = _publish(_weights(4000, 4000, 2000));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.VersionNotEffective.selector, id, waiting));
        vault.acceptVersion(id, waiting);
        _accept(1);
    }

    function test_acceptVersion_isTheOwners() public {
        address[3] memory callers = [stranger, keeper, creator];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, callers[i]));
            vault.acceptVersion(id, 1);
        }
    }

    /// Accepting another portfolio is following it instead: the first is announced as left.
    function test_acceptVersion_ofAnotherPortfolio_leavesTheFirst() public {
        _accept(1);
        vm.prank(stranger);
        bytes32 other = registry.create(keccak256("other"), _weights(3000, 3000, 4000), META, 0, 0);
        vm.expectEmit(address(vault));
        emit IBasketVault.Unfollowed(address(vault), id);
        vm.expectEmit(address(vault));
        emit IBasketVault.Followed(address(vault), other, 1);
        vm.prank(owner);
        vault.acceptVersion(other, 1);
        (bytes32 followed,,) = vault.following();
        assertEq(followed, other);
    }

    /// Paused, the owner's accept still works: it is not a keeper path.
    function test_acceptVersion_worksWhileTheKeeperIsPaused() public {
        vm.prank(guardian);
        factory.pauseKeeper();
        _accept(1);
    }

    /// An asset a version drops stays as a target of zero while the vault holds it, so the keeper can sell
    /// it; one it holds nothing of goes.
    function test_acceptVersion_keepsWhatTheVersionDropsWhileItIsHeld() public {
        _accept(1);
        _ownerBuys(address(stockC), 1000 * USD);
        // A held asset the version keeps is there once, at the version's weight.
        _ownerBuys(address(stockA), 1000 * USD);
        // Version 2 swaps C for D: 20% out and 20% in, a turnover of 20%.
        Weight[] memory four = new Weight[](4);
        BackdoorToken stockD = new BackdoorToken(dec);
        _list(address(stockD), dec);
        four[0] = Weight(address(stockA), 5000);
        four[1] = Weight(address(stockB), 3000);
        four[2] = Weight(address(stockD), 2000);
        four[3] = Weight(address(stockC), 0);
        Weight[] memory v2 = new Weight[](3);
        (v2[0], v2[1], v2[2]) = (four[0], four[1], four[2]);
        _publish(_sort(v2));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        _refresh();
        _accept(2);
        _assertTargets(_sort(four));

        // Sold, the leftover goes at the next version the owner takes.
        Swap memory sale = _sell(direct, address(stockC), stockC.balanceOf(address(vault)), 0);
        vm.prank(owner);
        vault.ownerSwap(_swaps(sale), LATER);
        vm.prank(owner);
        vault.setTargets(new Weight[](0));
        _accept(2);
        _assertTargets(_sort(v2));
    }

    /// A version and the assets it drops that are still held must fit 16 targets: the owner sells first.
    function test_acceptVersion_moreThanSixteenTargets_isRefused() public {
        Weight[] memory sixteen = new Weight[](16);
        for (uint256 i; i < 16; ++i) {
            BackdoorToken t = new BackdoorToken(dec);
            _list(address(t), dec);
            t.mint(address(vault), unit);
            sixteen[i] = Weight(address(t), 100);
        }
        vm.prank(owner);
        vault.setTargets(_sort(sixteen));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.InvalidTargets.selector, 1));
        vault.acceptVersion(id, 1);
    }

    // ---- auto-follow

    function test_setAutoFollow_isTheOwnersSwitch() public {
        vm.expectEmit(address(vault));
        emit IBasketVault.AutoFollowSet(address(vault), false);
        vm.prank(owner);
        vault.setAutoFollow(false);
        (,, bool on) = vault.following();
        assertFalse(on);

        address[3] memory callers = [stranger, keeper, guardian];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, callers[i]));
            vault.setAutoFollow(true);
        }
    }

    // ---- adopt

    function test_adoptVersion_takesAVersionThatOnlyChangesWeights() public {
        _accept(1);
        _publish(_weights(4000, 4000, 2000));
        // Waiting is not in effect.
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.VersionNotEffective.selector, id, 1));
        vault.adoptVersion();

        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.expectEmit(address(vault));
        emit IBasketVault.VersionAdopted(address(vault), id, 2);
        vm.prank(stranger);
        vault.adoptVersion();
        _assertTargets(_weights(4000, 4000, 2000));
        (, uint32 version,) = vault.following();
        assertEq(version, 2);

        // Nothing newer: refused again.
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.VersionNotEffective.selector, id, 2));
        vault.adoptVersion();
    }

    /// A14: a version with an asset the owner never accepted waits for the owner.
    function test_A14_aNewAsset_needsTheOwner() public {
        _accept(1);
        BackdoorToken stockD = new BackdoorToken(dec);
        _list(address(stockD), dec);
        Weight[] memory v2 = new Weight[](3);
        v2[0] = Weight(address(stockA), 5000);
        v2[1] = Weight(address(stockB), 3000);
        v2[2] = Weight(address(stockD), 2000);
        _publish(_sort(v2));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NewAssetNeedsOwner.selector, address(stockD)));
        vault.adoptVersion();
        _accept(2);
    }

    /// A14: an asset a version dropped is held at a target of zero and is no longer accepted. A version
    /// that brings it back waits for the owner.
    function test_A14_anAssetDroppedEarlier_needsTheOwnerToComeBack() public {
        _accept(1);
        _ownerBuys(address(stockC), 1000 * USD);
        BackdoorToken stockD = new BackdoorToken(dec);
        _list(address(stockD), dec);
        Weight[] memory v2 = new Weight[](3);
        v2[0] = Weight(address(stockA), 5000);
        v2[1] = Weight(address(stockB), 3000);
        v2[2] = Weight(address(stockD), 2000);
        _publish(_sort(v2));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        _accept(2);
        (bool found, uint16 bps) = _targetOf(address(stockC));
        assertTrue(found);
        assertEq(bps, 0);

        _publish(_threeStocks());
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NewAssetNeedsOwner.selector, address(stockC)));
        vault.adoptVersion();
    }

    /// The keeper sells what a version dropped.
    function test_adoptVersion_theKeeperSellsWhatTheVersionDropped() public {
        _accept(1);
        _ownerBuys(address(stockC), 1000 * USD);
        BackdoorToken stockD = new BackdoorToken(dec);
        _list(address(stockD), dec);
        Weight[] memory v2 = new Weight[](3);
        v2[0] = Weight(address(stockA), 5000);
        v2[1] = Weight(address(stockB), 3000);
        v2[2] = Weight(address(stockD), 2000);
        _publish(_sort(v2));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        _accept(2);
        _refresh();
        _keeperSwap(_sell(direct, address(stockC), stockC.balanceOf(address(vault)), 0));
        assertEq(stockC.balanceOf(address(vault)), 0);
    }

    function test_adoptVersion_autoFollowOff_isRefused() public {
        _accept(1);
        vm.prank(owner);
        vault.setAutoFollow(false);
        _publish(_weights(4000, 4000, 2000));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.AutoFollowOff.selector));
        vault.adoptVersion();
    }

    /// Adopt is a keeper path: the guardian's pause stops it. The owner's accept is never stopped.
    function test_adoptVersion_paused_isRefused() public {
        _accept(1);
        _publish(_weights(4000, 4000, 2000));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.prank(guardian);
        factory.pauseKeeper();
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.KeeperPaused.selector));
        vault.adoptVersion();
        _accept(2);
    }

    function test_adoptVersion_aVaultThatFollowsNothing_isRefused() public {
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.IndexNotFound.selector, bytes32(0)));
        vault.adoptVersion();
    }

    /// A vault created following a portfolio, with auto-follow on from the start, adopts the next version.
    function test_createVault_followingWithAutoFollow_adopts() public {
        vm.prank(owner);
        BasketVault made =
            BasketVault(payable(factory.createVault(keccak256("plan-follow"), new Weight[](0), id, 1, true)));
        (bytes32 followed, uint32 version, bool on) = made.following();
        assertEq(followed, id);
        assertEq(version, 1);
        assertTrue(on);
        _publish(_weights(4000, 4000, 2000));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        made.adoptVersion();
        (, version,) = made.following();
        assertEq(version, 2);
    }
}
