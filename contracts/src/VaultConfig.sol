// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IBasketVault} from "./interfaces/IBasketVault.sol";
import {IVaultConfig, PERMIT2} from "./interfaces/IVaultConfig.sol";
import {AssetConfig, Params} from "./interfaces/Types.sol";

/// The platform's settings for one chain, and the three roles around them: the cash token, the listed
/// assets with their price feeds, the allowed routers, the keeper's limits and the guardian's switches. A
/// vault is created by the contract that carries this and reads from it; nothing here is a constant in the
/// vault.
///
/// Two lists that must never overlap, now or later: a token that is or ever was a listed asset is never an
/// allowed router, and a router is never a listed asset. With a token as the "router", swap data could be
/// an `approve`, which moves no balance.
///
/// Nothing the guardian or the admin does here reaches the owner's way out. A vault's `withdraw` reads no
/// config at all. Its owner swap reads the cash token, the asset list and the router list, and never a
/// pause, a halt or the calendar. Its deposit reads those and two things more, both about new money only:
/// the guardian's deposit pause and the two deposit caps.
///
/// On a mainnet the admin is a timelock, so every `onlyAdmin` call below waits out its delay. What must be
/// fast is the guardian's, and the guardian can only stop things.
///
/// Abstract on purpose: `VaultFactory` inherits it, adds creation, and is the contract behind the UUPS
/// proxy. State lives in one ERC-7201 namespace; the factory keeps its own beside it.
abstract contract VaultConfig is Initializable, IVaultConfig {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @custom:storage-location erc7201:basket.storage.VaultConfig
    struct ConfigStorage {
        address admin;
        address pendingAdmin;
        EnumerableSet.AddressSet assetList;
        mapping(address token => AssetConfig) assets;
        mapping(address router => uint8) routerPull;
        address cashToken;
        // ---- appended by EVM-2
        // Assets taken off the list. Kept so that one can still be sold, and can never become a router.
        EnumerableSet.AddressSet removed;
        address guardian;
        bool keeperPaused;
        bool launched;
        uint64 closedUntil;
        address keeper;
        Params params;
        address sequencerFeed;
        mapping(uint32 day => bool) closedDays;
        address registry;
        // ---- appended by EVM-3
        // A keeper limit that `Params` has no room for: how far a price may be from its average.
        uint16 priceDevBps;
        // ---- appended by the mainnet setup. The first two share the slot of `registry` and `priceDevBps`.
        // The guardian's stop on new money.
        bool depositsPaused;
        // How old a US stock's price may be in session for the keeper; zero is no such rule.
        uint32 sessionPriceAge;
        // The deposit caps, in raw units of the cash token: one vault, and all of them together.
        uint256 vaultCap;
        uint256 totalCap;
        // What is counted toward the total cap: the sum of `deposited` over every vault.
        uint256 totalDeposited;
        // Each vault's net cash deposited as it last reported it.
        mapping(address vault => uint256) deposited;
    }

    // keccak256(abi.encode(uint256(keccak256("basket.storage.VaultConfig")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant CONFIG_STORAGE = 0xfd793af9d792c20ec648aa0fa0966554130cc76dee781a8faf62dee5e65f8b00;

    /// How a router pulls its input: 1 direct, 2 through Permit2. Anything above is not a known way.
    uint8 internal constant MAX_PULL = 2;
    /// `source`: 0 none, 1 Chainlink. `session`: 0 always, 1 US stocks.
    uint8 internal constant MAX_SOURCE = 1;
    uint8 internal constant MAX_SESSION = 1;
    /// Price maths scales by `10 ** decimals`; 18 is the most a listed token or a feed has.
    uint8 internal constant MAX_DECIMALS = 18;
    /// No asset may be more than half of a shared portfolio (section 6).
    uint16 internal constant MAX_ASSET_WEIGHT_BPS = 5000;
    /// How old a price may be set to count as fresh. The design uses 26 hours for stocks; a minute is
    /// shorter than any feed updates, and past two days a Friday close would pass for a Monday price.
    uint32 internal constant MIN_PRICE_AGE = 60;
    uint32 internal constant MAX_PRICE_AGE = 48 hours;
    /// The keeper's limits cannot be set looser than this without an upgrade (section 3.7, the same numbers
    /// as the Solana program): what a trade may lose against the reference price, what a week may lose, how
    /// far past its target a trade may leave an asset, the least and the most time between two keeper trades
    /// in one asset, and how far a price may be from its average.
    uint16 internal constant MAX_TOLERANCE_BPS = 300;
    uint16 internal constant MAX_LOSS_CAP_BPS = 500;
    uint16 internal constant MAX_BAND_BPS = 500;
    uint16 internal constant MAX_PRICE_DEV_BPS = 1000;
    uint32 internal constant MIN_ASSET_COOLDOWN = 600;
    /// Seven days, the window of the loss cap: a longer cooldown is a pause by another name.
    uint32 internal constant MAX_ASSET_COOLDOWN = 7 days;
    /// The in-session age of a stock's price cannot be set past the 26 hours of the design's `maxAge`.
    uint32 internal constant MAX_SESSION_PRICE_AGE = 26 hours;
    uint32 internal constant DAY = 86_400;
    /// Bit 0 of an asset's `flags`: the keeper may trade it and value a vault by its price.
    uint8 internal constant KEEPER_ON = 1;
    /// What the probe in `setRouter` may use. A token answers `allowance` in a few thousand.
    uint256 internal constant PROBE_GAS = 100_000;

    modifier onlyAdmin() {
        _checkAdmin();
        _;
    }

    /// The guardian's calls only tighten, so the admin may make them too.
    modifier onlyGuardian() {
        ConfigStorage storage $ = _config();
        require(msg.sender == $.guardian || msg.sender == $.admin, NotGuardian(msg.sender));
        _;
    }

    function _initVaultConfig(address admin_, Params memory params_) internal onlyInitializing {
        require(admin_ != address(0), ZeroAddress());
        _config().admin = admin_;
        emit AdminChanged(address(0), admin_);
        _setParams(params_);
        // No cap until the admin sets one. A mainnet's deploy sets both before the admin is handed over.
        _setDepositCaps(type(uint256).max, type(uint256).max);
    }

    // ---- admin: assets

    /// Lists an asset or replaces its settings, the price feed included. The stored `haltUntil` is kept and
    /// the one passed in is ignored: a halt is the guardian's, and a feed update must not lift it. Listing a
    /// removed asset again puts it back.
    ///
    /// The keeper's switch (`flags` bit 0) goes on only with a price to value the asset at: a Chainlink
    /// feed, its one-hour average as a feed of its own, and a range, the ceiling above the floor and at most
    /// twice it. The admin sets the range around a price checked against the pool, and moves it by hand.
    function setAsset(address token, AssetConfig calldata cfg) external onlyAdmin {
        require(token != address(0), ZeroAddress());
        require(token.code.length != 0, NoCode(token));
        ConfigStorage storage $ = _config();
        require($.routerPull[token] == 0, AssetIsRouter(token));
        require(cfg.source <= MAX_SOURCE, ParamOutOfBounds("source", cfg.source));
        require(cfg.session <= MAX_SESSION, ParamOutOfBounds("session", cfg.session));
        require(cfg.tokenDecimals <= MAX_DECIMALS, ParamOutOfBounds("tokenDecimals", cfg.tokenDecimals));
        require(cfg.feedDecimals <= MAX_DECIMALS, ParamOutOfBounds("feedDecimals", cfg.feedDecimals));
        require(cfg.maxWeightBps <= MAX_ASSET_WEIGHT_BPS, ParamOutOfBounds("maxWeightBps", cfg.maxWeightBps));
        require(cfg.source == 0 || cfg.feed != address(0), FeedRequired(token));
        if (cfg.feed != address(0)) {
            require(cfg.maxAge >= MIN_PRICE_AGE, ParamOutOfBounds("maxAge", cfg.maxAge));
            require(cfg.maxAge <= MAX_PRICE_AGE, ParamOutOfBounds("maxAge", cfg.maxAge));
        }
        require(cfg.flags <= KEEPER_ON, ParamOutOfBounds("flags", cfg.flags));
        bool ranged = cfg.minPrice != 0 || cfg.maxPrice != 0;
        if (ranged) {
            require(
                cfg.maxPrice > cfg.minPrice && cfg.maxPrice <= 2 * uint256(cfg.minPrice),
                ParamOutOfBounds("maxPrice", cfg.maxPrice)
            );
        }
        if (cfg.flags & KEEPER_ON != 0) {
            require(
                cfg.source == 1 && cfg.averageFeed != address(0) && cfg.averageFeed != cfg.feed && ranged,
                AssetNotPriced(token)
            );
        }

        // The vault never calls `decimals()`: it takes these on trust, so they are held to the token's and
        // the feeds' own answers here, where they are set. One that does not answer is left as stated.
        _checkDecimals(token, cfg.tokenDecimals);
        if (cfg.feed != address(0)) _checkDecimals(cfg.feed, cfg.feedDecimals);
        if (cfg.averageFeed != address(0)) _checkDecimals(cfg.averageFeed, cfg.feedDecimals);

        uint64 halt = $.assets[token].haltUntil;
        $.removed.remove(token);
        $.assetList.add(token);
        $.assets[token] = cfg;
        $.assets[token].haltUntil = halt;
        emit AssetSet(token, $.assets[token]);
    }

    /// @inheritdoc IVaultConfig
    /// @dev The settings and the halt stay stored. What changes is the list: `isAsset` turns false, so the
    /// token cannot be bought, named in new targets or published in a shared portfolio. Targets and shared
    /// portfolios that already name it are left as they are; nothing can buy toward them. A vault's own
    /// `tokens` are untouched, and `withdraw` never asks.
    function removeAsset(address token) external onlyAdmin {
        ConfigStorage storage $ = _config();
        require(token != $.cashToken, CashTokenNotRemovable(token));
        bool wasListed = $.assetList.remove(token);
        require(wasListed, AssetNotListed(token));
        $.removed.add(token);
        emit AssetRemoved(token);
    }

    /// Names the chain's dollar token, the only token a vault takes as a deposit. It must be a listed asset,
    /// which also means it is not zero, has code and is not a router.
    function setCashToken(address token) external onlyAdmin {
        ConfigStorage storage $ = _config();
        require($.assetList.contains(token), AssetNotListed(token));
        $.cashToken = token;
        emit CashTokenSet(token);
    }

    // ---- admin: routers

    /// Allows a router (1 direct, 2 through Permit2) or removes it (0). Removing always works.
    function setRouter(address router, uint8 pull) external onlyAdmin {
        require(router != address(0), ZeroAddress());
        require(pull <= MAX_PULL, InvalidPull(pull));
        ConfigStorage storage $ = _config();
        if (pull != 0) {
            require(router.code.length != 0, NoCode(router));
            // Covers the cash token too: it is always a listed asset. A removed asset stays refused.
            require(!$.assetList.contains(router) && !$.removed.contains(router), RouterIsAsset(router));
            require(!_isReserved(router), RouterReserved(router));
            require(!_answersAllowance(router), RouterIsToken(router));
        }
        $.routerPull[router] = pull;
        emit RouterSet(router, pull);
    }

    // ---- admin: roles, limits and the registry

    /// The registry is set once. It is a proxy, so its address does not change with its code.
    function setRegistry(address registry_) external onlyAdmin {
        ConfigStorage storage $ = _config();
        require($.registry == address(0), RegistryAlreadySet($.registry));
        require(registry_ != address(0), ZeroAddress());
        require(registry_.code.length != 0, NoCode(registry_));
        require($.routerPull[registry_] == 0, RouterReserved(registry_));
        $.registry = registry_;
        emit RegistrySet(registry_);
    }

    /// The zero address means there is no keeper.
    function setKeeper(address keeper_) external onlyAdmin {
        _config().keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// The zero address means there is no guardian; the admin can still make every guardian call.
    function setGuardian(address guardian_) external onlyAdmin {
        _config().guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// The zero address means the chain has no sequencer feed (Robinhood Chain).
    function setSequencerFeed(address feed) external onlyAdmin {
        _config().sequencerFeed = feed;
        emit SequencerFeedSet(feed);
    }

    function setParams(Params calldata p) external onlyAdmin {
        _setParams(p);
    }

    /// @inheritdoc IVaultConfig
    function setPriceDevBps(uint16 bps) external onlyAdmin {
        require(bps <= MAX_PRICE_DEV_BPS, ParamOutOfBounds("priceDevBps", bps));
        _config().priceDevBps = bps;
        emit PriceDevSet(bps);
    }

    function unpauseKeeper() external onlyAdmin {
        _config().keeperPaused = false;
        emit KeeperUnpaused();
    }

    function unpauseDeposits() external onlyAdmin {
        _config().depositsPaused = false;
        emit DepositsUnpaused();
    }

    /// @inheritdoc IVaultConfig
    function setDepositCaps(uint256 perVault, uint256 total) external onlyAdmin {
        _setDepositCaps(perVault, total);
    }

    /// @inheritdoc IVaultConfig
    function setSessionPriceAge(uint32 age) external onlyAdmin {
        require(
            age == 0 || (age >= MIN_PRICE_AGE && age <= MAX_SESSION_PRICE_AGE), ParamOutOfBounds("sessionPriceAge", age)
        );
        _config().sessionPriceAge = age;
        emit SessionPriceAgeSet(age);
    }

    /// @inheritdoc IVaultConfig
    function setHalt(address token, uint64 until) external onlyAdmin {
        _halt(token, until);
    }

    function setClosedUntil(uint64 until) external onlyAdmin {
        _config().closedUntil = until;
        emit ClosedUntilSet(until);
    }

    function setClosedDay(uint32 day, bool closed) external onlyAdmin {
        _config().closedDays[day] = closed;
        emit ClosedDaySet(day, closed);
    }

    /// @inheritdoc IVaultConfig
    /// @dev Routers, the cash token and the feeds stay the admin's to change after it, each with its event.
    ///
    /// The public comes in only once the keys are where they will stay. A deploy leaves the deployer as
    /// admin and as the beacon's owner until the admin key accepts each; launched in between, a deployer key
    /// could still replace every vault's code. So a proposed admin, or a beacon that is not the admin's, stops
    /// the launch.
    function launch() external onlyAdmin {
        ConfigStorage storage $ = _config();
        require(!$.launched, AlreadyLaunched());
        require($.pendingAdmin == address(0), AdminHandoverPending($.pendingAdmin));
        _checkLaunch();
        $.launched = true;
        emit Launched();
    }

    /// Step one of a handover. Nothing changes until `next` accepts, so a mistyped address cannot take the
    /// role. Proposing the zero address takes a proposal back.
    function proposeAdmin(address next) external onlyAdmin {
        _config().pendingAdmin = next;
        emit AdminProposed(next);
    }

    function acceptAdmin() external {
        ConfigStorage storage $ = _config();
        require(msg.sender == $.pendingAdmin, NotPendingAdmin(msg.sender));
        emit AdminChanged($.admin, msg.sender);
        $.admin = msg.sender;
        $.pendingAdmin = address(0);
    }

    // ---- guardian: tighten only. The keeper's path reads these; the owner's path never does

    function pauseKeeper() external onlyGuardian {
        _config().keeperPaused = true;
        emit KeeperPaused(msg.sender);
    }

    /// @inheritdoc IVaultConfig
    function haltAsset(address token, uint64 until) external onlyGuardian {
        uint64 stored = _config().assets[token].haltUntil;
        require(until > stored, OnlyTighten(stored, until));
        _halt(token, until);
    }

    function extendClosedUntil(uint64 until) external onlyGuardian {
        ConfigStorage storage $ = _config();
        require(until > $.closedUntil, OnlyTighten($.closedUntil, until));
        $.closedUntil = until;
        emit ClosedUntilSet(until);
    }

    function addClosedDay(uint32 day) external onlyGuardian {
        _config().closedDays[day] = true;
        emit ClosedDaySet(day, true);
    }

    /// @inheritdoc IVaultConfig
    /// @dev The one guardian switch a vault's owner feels, and only on the way in: `deposit` and the first
    /// deposit of a creation read it through `noteDeposit`. `withdraw` and `withdrawAll` call nothing here.
    function pauseDeposits() external onlyGuardian {
        _config().depositsPaused = true;
        emit DepositsPaused(msg.sender);
    }

    // ---- a vault, about itself, and anyone, about a vault

    /// @inheritdoc IVaultConfig
    /// @dev What is counted is cash that came in through `deposit` or creation, less cash that left through
    /// `withdraw` or `withdrawAll`, never below zero: the vault keeps that number and states it here. No
    /// price is read, so the caps do not see what the vault's holdings are worth now, and they do not see a
    /// token sent to a vault's address from outside, which no contract can refuse.
    function noteDeposit(uint256 netDeposited) external {
        require(_isVault(msg.sender), NotAVault(msg.sender));
        ConfigStorage storage $ = _config();
        require(!$.depositsPaused, DepositsArePaused());
        require(netDeposited <= $.vaultCap, VaultCapReached(msg.sender, netDeposited, $.vaultCap));
        uint256 total = $.totalDeposited - $.deposited[msg.sender] + netDeposited;
        require(total <= $.totalCap, TotalCapReached(total, $.totalCap));
        $.deposited[msg.sender] = netDeposited;
        $.totalDeposited = total;
        emit DepositCounted(msg.sender, netDeposited, total);
    }

    /// @inheritdoc IVaultConfig
    function syncDeposits(address[] calldata vaults) external {
        ConfigStorage storage $ = _config();
        for (uint256 i; i < vaults.length; ++i) {
            address vault = vaults[i];
            require(_isVault(vault), NotAVault(vault));
            uint256 counted = $.deposited[vault];
            uint256 current = IBasketVault(vault).netDeposited();
            if (current >= counted) continue;
            $.deposited[vault] = current;
            $.totalDeposited -= counted - current;
            emit DepositCounted(vault, current, $.totalDeposited);
        }
    }

    // ---- views

    function admin() public view returns (address) {
        return _config().admin;
    }

    function pendingAdmin() public view returns (address) {
        return _config().pendingAdmin;
    }

    /// @inheritdoc IVaultConfig
    function cashToken() public view returns (address) {
        return _config().cashToken;
    }

    /// @inheritdoc IVaultConfig
    function asset(address token) public view returns (AssetConfig memory) {
        return _config().assets[token];
    }

    /// @inheritdoc IVaultConfig
    function assets() public view returns (address[] memory) {
        return _config().assetList.values();
    }

    /// @inheritdoc IVaultConfig
    function isAsset(address token) public view returns (bool) {
        return _config().assetList.contains(token);
    }

    /// @inheritdoc IVaultConfig
    function wasAsset(address token) public view returns (bool) {
        ConfigStorage storage $ = _config();
        return $.assetList.contains(token) || $.removed.contains(token);
    }

    /// @inheritdoc IVaultConfig
    function removedAssets() public view returns (address[] memory) {
        return _config().removed.values();
    }

    /// @inheritdoc IVaultConfig
    function routerPull(address router) public view returns (uint8) {
        return _config().routerPull[router];
    }

    /// @inheritdoc IVaultConfig
    function registry() public view returns (address) {
        return _config().registry;
    }

    function keeper() public view returns (address) {
        return _config().keeper;
    }

    function guardian() public view returns (address) {
        return _config().guardian;
    }

    function sequencerFeed() public view returns (address) {
        return _config().sequencerFeed;
    }

    function keeperPaused() public view returns (bool) {
        return _config().keeperPaused;
    }

    /// @inheritdoc IVaultConfig
    function launched() public view returns (bool) {
        return _config().launched;
    }

    function closedUntil() public view returns (uint64) {
        return _config().closedUntil;
    }

    /// @inheritdoc IVaultConfig
    function closedDay(uint32 day) public view returns (bool) {
        return _config().closedDays[day];
    }

    function params()
        public
        view
        returns (
            uint16 toleranceBps,
            uint16 lossCapBps,
            uint16 bandBps,
            uint32 assetCooldown,
            uint32 sessionOpen,
            uint32 sessionClose
        )
    {
        Params storage p = _config().params;
        return (p.toleranceBps, p.lossCapBps, p.bandBps, p.assetCooldown, p.sessionOpen, p.sessionClose);
    }

    /// @inheritdoc IVaultConfig
    function priceDevBps() public view returns (uint16) {
        return _config().priceDevBps;
    }

    /// @inheritdoc IVaultConfig
    function sessionPriceAge() public view returns (uint32) {
        return _config().sessionPriceAge;
    }

    /// @inheritdoc IVaultConfig
    function depositCaps() public view returns (uint256 perVault, uint256 total) {
        ConfigStorage storage $ = _config();
        return ($.vaultCap, $.totalCap);
    }

    /// @inheritdoc IVaultConfig
    function depositsPaused() public view returns (bool) {
        return _config().depositsPaused;
    }

    /// @inheritdoc IVaultConfig
    function totalDeposited() public view returns (uint256) {
        return _config().totalDeposited;
    }

    /// @inheritdoc IVaultConfig
    function depositedOf(address vault) public view returns (uint256) {
        return _config().deposited[vault];
    }

    // ---- internals

    function _checkAdmin() internal view {
        require(msg.sender == _config().admin, NotAdmin(msg.sender));
    }

    /// What else must hold before `launch()`. The factory checks its beacon here.
    function _checkLaunch() internal view virtual {}

    /// The addresses that are part of the platform and so never a router. The factory adds its beacon and
    /// every vault.
    function _isReserved(address target) internal view virtual returns (bool) {
        return target == PERMIT2 || target == address(this) || target == _config().registry;
    }

    /// Whether `target` is a vault this config's factory created. The factory answers; on its own the
    /// config has none.
    function _isVault(address target) internal view virtual returns (bool) {
        target;
        return false;
    }

    function _setDepositCaps(uint256 perVault, uint256 total) private {
        require(perVault <= total, ParamOutOfBounds("vaultCap", perVault));
        ConfigStorage storage $ = _config();
        $.vaultCap = perVault;
        $.totalCap = total;
        emit DepositCapsSet(perVault, total);
    }

    /// Holds decimals stated for `what` to its own `decimals()`, when it answers a full word.
    function _checkDecimals(address what, uint8 stated) private view {
        bytes4 selector = 0x313ce567; // decimals()
        bool ok;
        uint256 answered;
        assembly ("memory-safe") {
            mstore(0x00, selector)
            ok := staticcall(PROBE_GAS, what, 0x00, 0x04, 0x00, 0x20)
            ok := and(ok, gt(returndatasize(), 0x1f))
            answered := mload(0x00)
        }
        if (!ok) return;
        require(answered == stated, DecimalsMismatch(what, stated, uint8(answered > 255 ? 255 : answered)));
    }

    function _setParams(Params memory p) private {
        require(p.toleranceBps <= MAX_TOLERANCE_BPS, ParamOutOfBounds("toleranceBps", p.toleranceBps));
        require(p.lossCapBps <= MAX_LOSS_CAP_BPS, ParamOutOfBounds("lossCapBps", p.lossCapBps));
        require(p.bandBps <= MAX_BAND_BPS, ParamOutOfBounds("bandBps", p.bandBps));
        require(p.assetCooldown >= MIN_ASSET_COOLDOWN, ParamOutOfBounds("assetCooldown", p.assetCooldown));
        require(p.assetCooldown <= MAX_ASSET_COOLDOWN, ParamOutOfBounds("assetCooldown", p.assetCooldown));
        require(p.sessionClose <= DAY, ParamOutOfBounds("sessionClose", p.sessionClose));
        require(p.sessionOpen < p.sessionClose, ParamOutOfBounds("sessionOpen", p.sessionOpen));
        _config().params = p;
        emit ParamsSet(p);
    }

    /// A halt is kept for an asset that is listed or was: a removed asset can be listed again, and its halt
    /// must still be there.
    function _halt(address token, uint64 until) private {
        ConfigStorage storage $ = _config();
        require($.assetList.contains(token) || $.removed.contains(token), AssetNotListed(token));
        $.assets[token].haltUntil = until;
        emit AssetHalted(token, until);
    }

    /// Whether `target` answers `allowance(address,address)` with a full word, as an ERC-20 does. No real
    /// router has that function. Nothing is copied back, and the call gets at most `PROBE_GAS`.
    function _answersAllowance(address target) private view returns (bool yes) {
        bytes memory probe = abi.encodeCall(IERC20.allowance, (address(this), address(this)));
        assembly ("memory-safe") {
            let ok := staticcall(PROBE_GAS, target, add(probe, 0x20), mload(probe), 0x00, 0x00)
            yes := and(ok, gt(returndatasize(), 0x1f))
        }
    }

    /// For the factory that inherits this: append fields to `ConfigStorage`, never reorder them.
    function _config() internal pure returns (ConfigStorage storage $) {
        assembly {
            $.slot := CONFIG_STORAGE
        }
    }
}
