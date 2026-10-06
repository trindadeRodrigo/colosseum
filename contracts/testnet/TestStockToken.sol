// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {TestToken} from "./TestToken.sol";

/// TEST NETWORK ONLY. A stock token shaped as Robinhood Chain's answer, so that the vault's two probes of a
/// stock token run against it unchanged: `effectiveAt()` for the multiplier window (`scheduleSelector`) and
/// `paused()` for the issuer's pause (`pauseProbe` on the token itself, `pauseSelector`).
///
/// The calls are the real token's, read from the implementation behind Robinhood's test TSLA
/// (0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E on chain 46630) on 2026-10-05: `uiMultiplier()`,
/// `newUIMultiplier()`, `effectiveAt()`, `updateMultiplier(uint256)`, `updateMultiplier(uint256,uint256)`,
/// `balanceOfUI(address)`, `totalSupplyUI()`, `paused()`, `pause()`, `unpause()`, `mint` and `burn`. What
/// the real token does between them is not published; this one does the plain thing: a multiplier set for a
/// time takes effect at that time, and a paused token moves nothing. Its permit, metadata and registry calls
/// are left out: the vault reads none of them.
///
/// The issuer role (pause and multiplier) and the minter role are the admin's to give.
contract TestStockToken is TestToken {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    /// The multiplier until `effectiveAt`, and the one from then on. 1e18 is one.
    uint256 private _multiplier = 1e18;
    uint256 private _newMultiplier = 1e18;
    uint256 private _effectiveAt;
    bool private _paused;

    event MultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAt);
    event Paused(address account);
    event Unpaused(address account);

    error TokenPaused();
    error ZeroMultiplier();
    error EffectiveInThePast(uint256 effectiveAt, uint256 now);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address admin)
        TestToken(name_, symbol_, decimals_, admin)
    {}

    /// The multiplier in effect now.
    function uiMultiplier() public view returns (uint256) {
        return block.timestamp >= _effectiveAt ? _newMultiplier : _multiplier;
    }

    /// The multiplier in effect from `effectiveAt()` on: the same as `uiMultiplier()` once that time is past.
    function newUIMultiplier() external view returns (uint256) {
        return _newMultiplier;
    }

    /// When the last change of the multiplier took or takes effect; zero before any change.
    function effectiveAt() external view returns (uint256) {
        return _effectiveAt;
    }

    function paused() external view returns (bool) {
        return _paused;
    }

    /// Alias the real token also answers.
    function tokenPaused() external view returns (bool) {
        return _paused;
    }

    function balanceOfUI(address account) external view returns (uint256) {
        return balanceOf(account) * uiMultiplier() / 1e18;
    }

    function totalSupplyUI() external view returns (uint256) {
        return totalSupply() * uiMultiplier() / 1e18;
    }

    /// A change that takes effect now.
    function updateMultiplier(uint256 newMultiplier) external onlyRole(ISSUER_ROLE) {
        _schedule(newMultiplier, block.timestamp);
    }

    /// A change that takes effect at `effectiveAt_`, now or later. It replaces a change still to come.
    function updateMultiplier(uint256 newMultiplier, uint256 effectiveAt_) external onlyRole(ISSUER_ROLE) {
        _schedule(newMultiplier, effectiveAt_);
    }

    function pause() external onlyRole(ISSUER_ROLE) {
        _paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyRole(ISSUER_ROLE) {
        _paused = false;
        emit Unpaused(msg.sender);
    }

    function _schedule(uint256 newMultiplier, uint256 effectiveAt_) private {
        require(newMultiplier != 0, ZeroMultiplier());
        require(effectiveAt_ >= block.timestamp, EffectiveInThePast(effectiveAt_, block.timestamp));
        uint256 current = uiMultiplier();
        _multiplier = current;
        _newMultiplier = newMultiplier;
        _effectiveAt = effectiveAt_;
        emit MultiplierUpdated(current, newMultiplier, effectiveAt_);
    }

    /// Every move, mint and burn included, stops while the issuer has paused the token.
    function _update(address from, address to, uint256 value) internal override {
        require(!_paused, TokenPaused());
        super._update(from, to, value);
    }
}
