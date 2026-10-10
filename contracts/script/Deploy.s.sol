// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {IndexRegistry} from "../src/IndexRegistry.sol";
import {AssetConfig, Params} from "../src/interfaces/Types.sol";
import {VaultBeacon} from "../src/VaultBeacon.sol";
import {VaultFactory} from "../src/VaultFactory.sol";

/// Deploys the vault contracts of one chain and writes the platform's first settings: the vault logic and
/// its beacon, the factory and the registry behind their proxies, the roles, the keeper's limits, the
/// listed assets, the routers and the cash token. Everything chain-specific comes from one JSON file,
/// `script/config/<chain id>.json`, or the file `DEPLOY_CONFIG` names.
///
///   forge script script/Deploy.s.sol --rpc-url <url> --sender <deployer>
///
/// That is a dry run: it simulates against the chain the URL answers for and prints every transaction it
/// would send, numbered, with its target and what it does. Sending is `--broadcast`, and a person does
/// that, never an agent.
///
/// The second entry, `settings()`, writes the file's assets, routers, cash token and closed days into a
/// factory already deployed, as its admin (`FACTORY` names it):
///
///   FACTORY=<address> forge script script/Deploy.s.sol --sig "settings()" --rpc-url <url> --sender <admin>
///
/// It is how a test network's tokens, feeds and exchange are listed once they exist, after the deploy.
///
/// The deployer is the admin and the beacon's owner while the script runs, so that it can write the
/// settings. How it ends depends on the file:
///
///   - With a `timelock` (required on a mainnet): the script creates OpenZeppelin's `TimelockController`,
///     hands the factory's admin and the beacon to it, and finishes the hand-over itself, so the deployer
///     ends the run holding nothing. The timelock starts with no delay and the deployer as a second
///     proposer and executor, for one batch only: accept the admin, accept the beacon, set the delay, and
///     take the deployer's three roles away. After that batch the only proposer, canceller and executor is
///     the file's `timelock.owner` (a Safe), every admin call waits out the delay, and the script reads all
///     of it back and fails if anything is otherwise.
///   - With an `admin` and no timelock (a test network): it proposes that key for both. Until the key
///     accepts (`acceptAdmin()` on the factory, `acceptOwnership()` on the beacon), the deployer holds both.
///   - With `adminIsDeployer`: the deployer keeps both, as on a test network with one key.
///
/// The script does not call `launch()`.
///
/// On a mainnet (any chain id that is not a known test network) the file is held to the rules of
/// `checkMainnet` before anything is created: see there. `settings()` is refused on a mainnet: there the
/// settings are the timelock's to change, through the Safe.
contract Deploy is Script {
    using stdJson for string;

    struct Asset {
        address token;
        AssetConfig config;
    }

    struct Router {
        address router;
        uint8 pull;
    }

    struct Config {
        uint256 chainId;
        /// The deployer stays the admin and the beacon's owner: one key, as on a test network.
        bool adminIsDeployer;
        address admin;
        address guardian;
        address keeper;
        address sequencerFeed;
        uint32 publishDelay;
        Params params;
        uint16 priceDevBps;
        address cashToken;
        Asset[] assets;
        Router[] routers;
        uint32[] closedDays;
        /// Who proposes to, cancels in and executes from the timelock: a Safe. Zero for no timelock.
        address timelockOwner;
        /// Seconds every admin call waits. On a mainnet at least `MIN_MAINNET_DELAY`.
        uint256 timelockDelay;
        /// Whether this deploy means the keeper to run. False: no keeper address and no asset's switch.
        bool keeperEnabled;
        /// The deposit caps, in raw units of the cash token. `hasCaps` false leaves the factory with none.
        bool hasCaps;
        uint256 vaultCap;
        uint256 totalCap;
        /// How old a stock's price may be in session for the keeper. Zero for no such rule.
        uint32 sessionPriceAge;
        /// One entry per asset, in the assets' order: what the feed's `description()` must answer, for
        /// example "RHNVDA / USD". Required on a mainnet for an asset with a feed; not read elsewhere.
        string[] feedDescriptions;
        /// The fewest signatures the timelock's owner, a Safe, must need. 2 when the file does not say; a
        /// mainnet file may raise it and may not lower it.
        uint256 safeMinThreshold;
        /// Whether anyone may create a vault. False with `creators` named restricts creation to them.
        bool openToAll;
        address[] creators;
        /// The file still holds the word TODO somewhere: a value nobody has confirmed.
        bool placeholders;
    }

    struct Deployed {
        address vaultLogic;
        address beacon;
        address factoryLogic;
        address factory;
        address registryLogic;
        address registry;
        /// Zero when the file has no timelock.
        address timelock;
    }

    /// 48 hours: the notice a follower already gets before a new version of a shared portfolio takes
    /// effect, so one number answers "how long before anything about my vault can change". It is long
    /// enough to be seen by someone who looks every other day and to leave in kind, and short enough that a
    /// fix is not a week away; what cannot wait is the guardian's, which has no delay and can only stop.
    uint256 public constant MIN_MAINNET_DELAY = 48 hours;
    uint256 public constant MAX_MAINNET_DELAY = 30 days;
    /// Before an audit: the most all vaults of a mainnet factory may take in, in whole dollars. Raising it
    /// is a change to this file, reviewed, and then a call through the timelock.
    uint256 public constant UNAUDITED_TOTAL_CAP_DOLLARS = 10_000;
    /// A mainnet's keeper limits, tighter than the contract's own hard bounds (M2 of the review): what a
    /// stolen keeper key can cost a vault is the weekly cap at once and twice it in seven days.
    uint16 public constant MAINNET_MAX_TOLERANCE_BPS = 150;
    uint16 public constant MAINNET_MAX_LOSS_CAP_BPS = 200;
    uint16 public constant MAINNET_MAX_PRICE_DEV_BPS = 200;
    uint32 public constant MAINNET_MIN_COOLDOWN = 3600;
    /// A keeper's price range on a mainnet: the ceiling at most 36% above the floor, about 15% either side.
    uint256 public constant MAINNET_MAX_RANGE_PCT = 136;

    /// A Safe one signature moves is a key with extra steps.
    uint256 public constant MIN_SAFE_THRESHOLD = 2;

    uint256 internal constant ROBINHOOD = 4663;
    uint256 internal constant BASE = 8453;
    /// Robinhood Chain's dollar token (USDG) and its one router (Universal Router 2.1.2).
    address internal constant ROBINHOOD_CASH = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ROBINHOOD_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498;

    error WrongChain(uint256 configIsFor, uint256 runningOn);
    error NoAdmin();
    /// The file breaks a rule a mainnet deploy is held to. `rule` says which, in words.
    error MainnetRefused(string rule);
    /// An asset's average feed is for another token, another feed, another cash token or other decimals:
    /// a wrong paste. `what` says which.
    error AverageFeedMismatch(address token, address averageFeed, string what);
    /// After the hand-over to the timelock, something is not where it must be.
    error HandoverIncomplete(string what);
    /// A number in the file is too large for its field, or a selector is not four bytes long.
    error ValueDoesNotFit(string key, uint256 value, uint256 most);

    /// Transactions printed so far in this run.
    uint256 public sent;

    function run() external returns (Deployed memory d) {
        Config memory cfg = readConfig(_path());
        vm.startBroadcast();
        d = deploy(cfg, msg.sender);
        vm.stopBroadcast();
        _print(cfg, d, msg.sender);
    }

    /// Lists the file's assets, routers, cash token and closed days on the factory `FACTORY` names, and sets
    /// the keeper's limits, as its admin. Nothing else: no role changes hands.
    function settings() external {
        require(
            !isMainnet(block.chainid),
            MainnetRefused("settings() is for test networks: on a mainnet the timelock changes settings")
        );
        Config memory cfg = readConfig(_path());
        VaultFactory factory = VaultFactory(vm.envAddress("FACTORY"));
        vm.startBroadcast();
        writeSettings(cfg, factory);
        vm.stopBroadcast();
        console2.log("factory:", address(factory));
        console2.log("transactions:", sent);
    }

    /// Deploys and configures, as `deployer`: the address the calls below come from.
    function deploy(Config memory cfg, address deployer) public returns (Deployed memory d) {
        require(cfg.chainId == block.chainid, WrongChain(cfg.chainId, block.chainid));
        if (isMainnet(block.chainid)) checkMainnet(cfg, deployer);
        bool timelocked = cfg.timelockOwner != address(0);
        if (cfg.adminIsDeployer) cfg.admin = deployer;
        require(cfg.admin != address(0) || timelocked, NoAdmin());

        // Every proxy is created with its init call inside its constructor, and the beacon with its owner.
        d.vaultLogic = address(new BasketVault());
        _tx(d.vaultLogic, "create the vault logic (BasketVault)");
        d.beacon = address(new VaultBeacon(d.vaultLogic, deployer));
        _tx(d.beacon, "create the beacon (VaultBeacon), owned by the deployer, pointing at the vault logic");
        d.factoryLogic = address(new VaultFactory());
        _tx(d.factoryLogic, "create the factory logic (VaultFactory)");
        bytes memory init = abi.encodeCall(VaultFactory.initialize, (deployer, d.beacon, cfg.params));
        d.factory = address(new ERC1967Proxy(d.factoryLogic, init));
        _tx(d.factory, "create the factory proxy: initialize(deployer as admin, beacon, keeper limits)");
        d.registryLogic = address(new IndexRegistry());
        _tx(d.registryLogic, "create the registry logic (IndexRegistry)");
        init = abi.encodeCall(IndexRegistry.initialize, (d.factory, cfg.publishDelay));
        d.registry = address(new ERC1967Proxy(d.registryLogic, init));
        _tx(d.registry, string.concat("create the registry proxy: initialize(factory, ", _n(cfg.publishDelay), " s)"));

        VaultFactory factory = VaultFactory(d.factory);
        factory.setRegistry(d.registry);
        _tx(d.factory, "setRegistry(registry)");
        factory.setGuardian(cfg.guardian);
        _tx(d.factory, string.concat("setGuardian(", vm.toString(cfg.guardian), ")"));
        factory.setKeeper(cfg.keeper);
        _tx(d.factory, string.concat("setKeeper(", vm.toString(cfg.keeper), ")"));
        if (cfg.sequencerFeed != address(0)) {
            factory.setSequencerFeed(cfg.sequencerFeed);
            _tx(d.factory, string.concat("setSequencerFeed(", vm.toString(cfg.sequencerFeed), ")"));
        }
        writeSettings(cfg, factory);

        if (timelocked) {
            d.timelock = _handOverToTimelock(cfg, d, deployer);
            checkHandover(cfg, d, deployer);
            return d;
        }
        // Hand both keys over. Each takes the new holder's own call to complete.
        if (cfg.admin != deployer) {
            factory.proposeAdmin(cfg.admin);
            _tx(d.factory, string.concat("proposeAdmin(", vm.toString(cfg.admin), ")"));
            VaultBeacon(d.beacon).transferOwnership(cfg.admin);
            _tx(d.beacon, string.concat("transferOwnership(", vm.toString(cfg.admin), ")"));
        }
    }

    /// Creates the timelock and ends with it holding the factory's admin and the beacon, at the file's
    /// delay, with the file's owner as its only proposer, canceller and executor.
    ///
    /// The hand-over of each key takes the new holder's own call, and the new holder is the timelock, which
    /// only acts on a scheduled operation. So the timelock is created with no delay and with the deployer
    /// beside the owner, and the deployer schedules and executes one batch: both accept calls, the delay,
    /// and the removal of its own three roles. The timelock administers its own roles and nobody else does
    /// (its constructor is given no admin), so after the batch the deployer has no way back in.
    function _handOverToTimelock(Config memory cfg, Deployed memory d, address deployer) private returns (address) {
        address[] memory holders = new address[](2);
        holders[0] = cfg.timelockOwner;
        holders[1] = deployer;
        TimelockController timelock = new TimelockController(0, holders, holders, address(0));
        address lock = address(timelock);
        _tx(
            lock,
            "create the timelock (TimelockController): no delay yet; proposers and executors the owner and the deployer"
        );

        VaultFactory(d.factory).proposeAdmin(lock);
        _tx(d.factory, "proposeAdmin(timelock)");
        VaultBeacon(d.beacon).transferOwnership(lock);
        _tx(d.beacon, "transferOwnership(timelock)");

        address[] memory targets = new address[](6);
        bytes[] memory calls = new bytes[](6);
        uint256[] memory values = new uint256[](6);
        targets[0] = d.factory;
        calls[0] = abi.encodeCall(VaultFactory(d.factory).acceptAdmin, ());
        targets[1] = d.beacon;
        calls[1] = abi.encodeCall(VaultBeacon(d.beacon).acceptOwnership, ());
        targets[2] = lock;
        calls[2] = abi.encodeCall(timelock.updateDelay, (cfg.timelockDelay));
        targets[3] = lock;
        calls[3] = abi.encodeCall(timelock.revokeRole, (timelock.PROPOSER_ROLE(), deployer));
        targets[4] = lock;
        calls[4] = abi.encodeCall(timelock.revokeRole, (timelock.CANCELLER_ROLE(), deployer));
        targets[5] = lock;
        calls[5] = abi.encodeCall(timelock.revokeRole, (timelock.EXECUTOR_ROLE(), deployer));
        bytes32 salt = keccak256("handover");
        timelock.scheduleBatch(targets, values, calls, bytes32(0), salt, 0);
        _tx(lock, "scheduleBatch: acceptAdmin, acceptOwnership, updateDelay, and revoke the deployer's three roles");
        timelock.executeBatch(targets, values, calls, bytes32(0), salt);
        _tx(
            lock,
            string.concat(
                "executeBatch: the timelock now holds both keys, waits ",
                _n(cfg.timelockDelay),
                " s, and answers only its owner"
            )
        );
        return lock;
    }

    /// Reads back where everything is after the hand-over to the timelock, and fails the run if any of it
    /// is not as the file says. `authority-check` makes the same reads later, from outside.
    function checkHandover(Config memory cfg, Deployed memory d, address deployer) public view {
        TimelockController timelock = TimelockController(payable(d.timelock));
        VaultFactory factory = VaultFactory(d.factory);
        VaultBeacon beacon = VaultBeacon(d.beacon);
        require(factory.admin() == d.timelock, HandoverIncomplete("the factory's admin is not the timelock"));
        require(factory.pendingAdmin() == address(0), HandoverIncomplete("an admin hand-over is still proposed"));
        require(beacon.owner() == d.timelock, HandoverIncomplete("the beacon's owner is not the timelock"));
        require(beacon.pendingOwner() == address(0), HandoverIncomplete("a beacon hand-over is still proposed"));
        require(
            timelock.getMinDelay() == cfg.timelockDelay, HandoverIncomplete("the timelock's delay is not the file's")
        );

        bytes32[4] memory roles = [
            timelock.PROPOSER_ROLE(),
            timelock.CANCELLER_ROLE(),
            timelock.EXECUTOR_ROLE(),
            timelock.DEFAULT_ADMIN_ROLE()
        ];
        for (uint256 i; i < roles.length; ++i) {
            require(
                !timelock.hasRole(roles[i], deployer), HandoverIncomplete("the deployer still holds a timelock role")
            );
            // Execution open to anyone would be the zero address holding the executor role.
            require(!timelock.hasRole(roles[i], address(0)), HandoverIncomplete("a timelock role is open to anyone"));
            bool ownerHolds = timelock.hasRole(roles[i], cfg.timelockOwner);
            require(
                ownerHolds == (i < 3),
                HandoverIncomplete("the owner's timelock roles are not proposer, canceller, executor")
            );
        }
        require(
            timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), d.timelock),
            HandoverIncomplete("the timelock does not administer its own roles")
        );
    }

    /// Holds an asset's average feed to the asset, before it is listed. A pool-average feed
    /// (`src/price/PoolAverageFeed.sol`) names what it averages: `base()` the token, `feed()` the Chainlink
    /// feed it is checked against, `quote()` the cash token, and its `decimals()`. One built for another
    /// asset would list without complaint, and the keeper would then refuse every trade in the asset with
    /// nothing to say why. A feed that names none of this (a test network's price contract) is left to
    /// `setAsset`, and is refused on a mainnet by `checkMainnet`. Returns whether the feed named its asset.
    function checkAverageFeed(Asset memory a, address cashToken) public view returns (bool named) {
        address average = a.config.averageFeed;
        if (average == address(0)) return false;
        (bool hasBase, uint256 base) = _word(average, bytes4(keccak256("base()")));
        (bool hasFeed, uint256 feed) = _word(average, bytes4(keccak256("feed()")));
        (bool hasQuote, uint256 quote) = _word(average, bytes4(keccak256("quote()")));
        if (!hasBase && !hasFeed && !hasQuote) return false;
        require(
            hasBase && base == uint160(a.token),
            AverageFeedMismatch(a.token, average, "base() is not the asset's token")
        );
        require(
            hasFeed && feed == uint160(a.config.feed),
            AverageFeedMismatch(a.token, average, "feed() is not the asset's feed")
        );
        require(
            hasQuote && quote == uint160(cashToken),
            AverageFeedMismatch(a.token, average, "quote() is not the cash token")
        );
        (bool ok, uint256 decimals) = _word(average, 0x313ce567);
        require(
            ok && decimals == a.config.feedDecimals,
            AverageFeedMismatch(a.token, average, "decimals() are not the asset's feedDecimals")
        );
        return true;
    }

    // ---- what a mainnet file is held to

    /// A chain id that is not a known test network is treated as a mainnet: the local chain, Robinhood
    /// Chain's test network and Base Sepolia are the test networks.
    function isMainnet(uint256 chainId) public pure returns (bool) {
        return chainId != 31337 && chainId != 46630 && chainId != 84532;
    }

    /// Refuses a file that must not be deployed where real money will be. Nothing is created before this
    /// passes. In order: placeholders; who holds what; the keeper; the caps; the cash token and the routers;
    /// every asset's token and feeds.
    function checkMainnet(Config memory cfg, address deployer) public view {
        require(
            !cfg.placeholders, MainnetRefused("the file still holds a TODO: every value must be confirmed by a person")
        );

        // Who holds what (H1, H2, M4 of the review).
        require(!cfg.adminIsDeployer, MainnetRefused("adminIsDeployer: the deployer must end with nothing"));
        require(
            cfg.admin == address(0),
            MainnetRefused("admin is set: on a mainnet the admin is the timelock the script creates")
        );
        require(cfg.timelockOwner != address(0), MainnetRefused("no timelock owner"));
        require(
            cfg.timelockOwner.code.length != 0,
            MainnetRefused("the timelock owner has no code: it must be a contract (a Safe), not a key")
        );
        require(cfg.timelockOwner != deployer, MainnetRefused("the timelock owner is the deployer"));
        require(
            cfg.safeMinThreshold >= MIN_SAFE_THRESHOLD,
            MainnetRefused("safeMinThreshold is under 2: one signature is a key")
        );
        checkSafe(cfg.timelockOwner, cfg.safeMinThreshold);
        require(cfg.timelockDelay >= MIN_MAINNET_DELAY, MainnetRefused("the timelock delay is under 48 hours"));
        require(cfg.timelockDelay <= MAX_MAINNET_DELAY, MainnetRefused("the timelock delay is over 30 days"));
        require(cfg.guardian != address(0), MainnetRefused("no guardian"));
        require(cfg.guardian != deployer, MainnetRefused("the guardian is the deployer"));
        require(cfg.publishDelay >= MIN_MAINNET_DELAY, MainnetRefused("the publish delay is under 172,800 s"));

        // The keeper: either wholly off, or on inside a mainnet's limits (H3, M1, M2).
        bool anyKeeperAsset;
        bool anyKeeperStock;
        for (uint256 i; i < cfg.assets.length; ++i) {
            if (cfg.assets[i].config.flags & 1 != 0) {
                anyKeeperAsset = true;
                if (cfg.assets[i].config.session == 1) anyKeeperStock = true;
            }
        }
        if (!cfg.keeperEnabled) {
            require(cfg.keeper == address(0), MainnetRefused("a keeper is set while keeperEnabled is false"));
            require(!anyKeeperAsset, MainnetRefused("an asset's keeper switch is on while keeperEnabled is false"));
        } else {
            require(cfg.keeper != address(0), MainnetRefused("keeperEnabled with no keeper"));
            require(
                cfg.keeper != cfg.guardian,
                MainnetRefused("the keeper is the guardian: the key that stops the keeper must not be the keeper's")
            );
            require(cfg.keeper != deployer, MainnetRefused("the keeper is the deployer"));
            require(cfg.params.toleranceBps <= MAINNET_MAX_TOLERANCE_BPS, MainnetRefused("toleranceBps is over 150"));
            require(cfg.params.lossCapBps <= MAINNET_MAX_LOSS_CAP_BPS, MainnetRefused("lossCapBps is over 200"));
            require(cfg.params.assetCooldown >= MAINNET_MIN_COOLDOWN, MainnetRefused("assetCooldown is under 3,600 s"));
            require(
                cfg.priceDevBps != 0 && cfg.priceDevBps <= MAINNET_MAX_PRICE_DEV_BPS,
                MainnetRefused("priceDevBps is zero or over 200")
            );
            require(
                !anyKeeperStock || cfg.sessionPriceAge != 0,
                MainnetRefused("sessionPriceAge is zero with the keeper on for a stock")
            );
        }

        // Who may create a vault. The total cap can be used up by anyone who can create one, so while it is
        // small the file either names who may, or says in so many words that anyone may.
        require(
            cfg.openToAll || cfg.creators.length != 0, MainnetRefused("no creator is named while openToAll is false")
        );
        require(
            !cfg.openToAll || cfg.creators.length == 0, MainnetRefused("creators are named while openToAll is true")
        );
        for (uint256 i; i < cfg.creators.length; ++i) {
            require(cfg.creators[i] != address(0), MainnetRefused("a creator is the zero address"));
        }

        // The caps before an audit.
        require(cfg.hasCaps, MainnetRefused("no deposit caps"));
        require(cfg.vaultCap != 0 && cfg.totalCap != 0, MainnetRefused("a deposit cap of zero"));
        require(cfg.vaultCap <= cfg.totalCap, MainnetRefused("the cap of one vault is above the total"));

        // The cash token and the routers.
        require(cfg.cashToken != address(0), MainnetRefused("no cash token"));
        if (block.chainid == ROBINHOOD) {
            require(cfg.cashToken == ROBINHOOD_CASH, MainnetRefused("the cash token is not Robinhood Chain's USDG"));
            require(cfg.sequencerFeed == address(0), MainnetRefused("Robinhood Chain has no sequencer feed"));
        } else if (cfg.sequencerFeed != address(0)) {
            _requireRealFeed(cfg.sequencerFeed, "the sequencer feed");
        }
        for (uint256 i; i < cfg.routers.length; ++i) {
            address router = cfg.routers[i].router;
            require(router.code.length != 0, MainnetRefused("a router has no code"));
            if (block.chainid == ROBINHOOD) {
                require(
                    router == ROBINHOOD_ROUTER && cfg.routers[i].pull == 2,
                    MainnetRefused("a router that is not Universal Router 2.1.2 through Permit2")
                );
            }
        }

        // Every asset: a real token with the decimals stated, and feeds that are Chainlink's.
        bool cashListed;
        for (uint256 i; i < cfg.assets.length; ++i) {
            Asset memory a = cfg.assets[i];
            string memory description = i < cfg.feedDescriptions.length ? cfg.feedDescriptions[i] : "";
            require(a.token.code.length != 0, MainnetRefused("an asset's token has no code"));
            (bool ok, uint256 decimals) = _word(a.token, 0x313ce567);
            require(
                ok && decimals == a.config.tokenDecimals, MainnetRefused("an asset's tokenDecimals are not the token's")
            );
            if (a.token == cfg.cashToken) {
                cashListed = true;
                require(
                    cfg.totalCap <= UNAUDITED_TOTAL_CAP_DOLLARS * 10 ** decimals,
                    MainnetRefused("the total cap is over 10,000 dollars before an audit")
                );
            }
            if (a.config.pauseProbe != address(0)) {
                (ok,) = _word(a.config.pauseProbe, a.config.pauseSelector);
                require(ok, MainnetRefused("an asset's pause probe does not answer"));
            }
            if (a.config.scheduleSelector != bytes4(0)) {
                (ok,) = _word(a.token, a.config.scheduleSelector);
                require(ok, MainnetRefused("an asset's token does not answer its schedule selector"));
            }
            if (a.config.feed == address(0)) {
                require(
                    a.config.flags == 0 && a.config.averageFeed == address(0),
                    MainnetRefused("an asset with no feed has an average or the keeper's switch")
                );
                continue;
            }
            _requireRealFeed(a.config.feed, "an asset's feed");
            (ok, decimals) = _word(a.config.feed, 0x313ce567);
            require(
                ok && decimals == a.config.feedDecimals, MainnetRefused("an asset's feedDecimals are not the feed's")
            );
            // A Chainlink feed is a proxy that names the aggregator behind it, and says what it prices.
            (bool named, uint256 aggregator) = _word(a.config.feed, 0x245a7bfc);
            require(
                named && aggregator != 0 && aggregator <= type(uint160).max
                    && address(uint160(aggregator)).code.length != 0,
                MainnetRefused("an asset's feed names no aggregator: not a Chainlink feed")
            );
            require(bytes(description).length != 0, MainnetRefused("an asset's feedDescription is missing"));
            require(
                _descriptionIs(a.config.feed, description),
                MainnetRefused("an asset's feed does not describe itself as the file says")
            );
            if (a.config.averageFeed != address(0)) {
                _requireRealFeed(a.config.averageFeed, "an asset's average feed");
                (ok, decimals) = _word(a.config.averageFeed, 0x313ce567);
                require(
                    ok && decimals == a.config.feedDecimals,
                    MainnetRefused("an average feed's decimals are not the feed's")
                );
                require(
                    checkAverageFeed(a, cfg.cashToken),
                    MainnetRefused(
                        "an asset's average feed does not name its token, feed and cash: not a pool-average feed"
                    )
                );
            }
            if (a.config.flags & 1 != 0) {
                require(
                    uint256(a.config.maxPrice) * 100 <= uint256(a.config.minPrice) * MAINNET_MAX_RANGE_PCT,
                    MainnetRefused("a keeper asset's price range is wider than about 15% either side")
                );
            }
        }
        require(cashListed, MainnetRefused("the cash token is not among the assets"));
    }

    /// Holds the timelock's owner to being a Safe more than one person must sign for. "Has code" is not
    /// enough: a contract one key controls has code, and so does a plain key that has delegated its code
    /// (EIP-7702: 23 bytes that start 0xef0100). It must answer as a Safe does, `getThreshold()` and
    /// `getOwners()`, need at least `minThreshold` signatures, and have at least two owners and no fewer
    /// than it needs. This reads what the contract says of itself; that it is a real Safe with these
    /// people behind it is for a person to compare with the owners the run prints.
    function checkSafe(address safe, uint256 minThreshold)
        public
        view
        returns (uint256 threshold, address[] memory owners)
    {
        bytes memory code = safe.code;
        require(
            code.length != 0,
            MainnetRefused("the timelock owner has no code: it must be a contract (a Safe), not a key")
        );
        require(
            !(code.length == 23 && code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00),
            MainnetRefused("the timelock owner is a key with delegated code (EIP-7702), not a Safe")
        );
        bool ok;
        (ok, threshold) = _word(safe, bytes4(keccak256("getThreshold()")));
        require(ok, MainnetRefused("the timelock owner does not answer getThreshold(): not a Safe"));
        bytes memory ret;
        (ok, ret) = safe.staticcall(abi.encodeWithSelector(bytes4(keccak256("getOwners()"))));
        require(ok && ret.length >= 64, MainnetRefused("the timelock owner does not answer getOwners(): not a Safe"));
        uint256 count;
        assembly ("memory-safe") {
            count := mload(add(ret, 0x40))
        }
        require(
            ret.length == 64 + count * 32, MainnetRefused("the timelock owner does not answer getOwners(): not a Safe")
        );
        owners = abi.decode(ret, (address[]));
        require(threshold >= minThreshold, MainnetRefused("the Safe needs fewer signatures than safeMinThreshold"));
        require(owners.length >= 2, MainnetRefused("the Safe has fewer than two owners"));
        require(owners.length >= threshold, MainnetRefused("the Safe needs more signatures than it has owners"));
    }

    /// A feed on a mainnet has code and is not one of ours: `TestPriceFeed` answers `writer()` and
    /// `StubSequencerFeed` answers `down()`, each the mark of a value one key sets; a Chainlink feed has
    /// neither. The contracts in `testnet/` also refuse to be created on a mainnet at all; this is the
    /// check from the other side, on whatever address a file names.
    function _requireRealFeed(address feed, string memory what) private view {
        require(feed.code.length != 0, MainnetRefused(string.concat(what, " has no code")));
        (bool hasWriter,) = _word(feed, bytes4(keccak256("writer()")));
        (bool hasDown,) = _word(feed, bytes4(keccak256("down()")));
        require(!hasWriter && !hasDown, MainnetRefused(string.concat(what, " is a test contract: one key writes it")));
    }

    function _descriptionIs(address feed, string memory expected) private view returns (bool) {
        (bool ok, bytes memory ret) = feed.staticcall(abi.encodeWithSelector(0x7284e416)); // description()
        if (!ok || ret.length < 64) return false;
        return keccak256(bytes(abi.decode(ret, (string)))) == keccak256(bytes(expected));
    }

    /// One word from a view that takes no argument; `ok` is false for a revert, an address with no code or
    /// a short answer.
    function _word(address target, bytes4 selector) private view returns (bool ok, uint256 word) {
        if (target.code.length == 0) return (false, 0);
        bytes memory ret;
        (ok, ret) = target.staticcall(abi.encodeWithSelector(selector));
        if (!ok || ret.length < 32) return (false, 0);
        word = abi.decode(ret, (uint256));
    }

    /// The settings that are the admin's to write at any time: the price deviation, the assets, the cash
    /// token, the routers and the closed days. The keeper's other limits went in with `initialize`.
    function writeSettings(Config memory cfg, VaultFactory factory) public {
        address to = address(factory);
        factory.setPriceDevBps(cfg.priceDevBps);
        _tx(to, string.concat("setPriceDevBps(", _n(cfg.priceDevBps), ")"));
        if (cfg.sessionPriceAge != 0) {
            factory.setSessionPriceAge(cfg.sessionPriceAge);
            _tx(to, string.concat("setSessionPriceAge(", _n(cfg.sessionPriceAge), ")"));
        }
        for (uint256 i; i < cfg.creators.length; ++i) {
            factory.setCreator(cfg.creators[i], true);
            _tx(to, string.concat("setCreator(", vm.toString(cfg.creators[i]), ", may create a vault)"));
        }
        if (cfg.creators.length != 0) {
            factory.setCreationRestricted(true);
            _tx(to, "setCreationRestricted(true): only the creators above may create a vault");
        }
        if (cfg.hasCaps) {
            factory.setDepositCaps(cfg.vaultCap, cfg.totalCap);
            _tx(
                to, string.concat("setDepositCaps(one vault ", _n(cfg.vaultCap), ", all vaults ", _n(cfg.totalCap), ")")
            );
        }
        for (uint256 i; i < cfg.assets.length; ++i) {
            Asset memory a = cfg.assets[i];
            checkAverageFeed(a, cfg.cashToken);
            factory.setAsset(a.token, a.config);
            _tx(
                to,
                string.concat(
                    "setAsset(",
                    vm.toString(a.token),
                    ", feed ",
                    vm.toString(a.config.feed),
                    ", average ",
                    vm.toString(a.config.averageFeed),
                    ", range ",
                    _n(a.config.minPrice),
                    " to ",
                    _n(a.config.maxPrice),
                    ", keeper ",
                    a.config.flags == 1 ? "on)" : "off)"
                )
            );
        }
        if (cfg.cashToken != address(0)) {
            factory.setCashToken(cfg.cashToken);
            _tx(to, string.concat("setCashToken(", vm.toString(cfg.cashToken), ")"));
        }
        for (uint256 i; i < cfg.routers.length; ++i) {
            factory.setRouter(cfg.routers[i].router, cfg.routers[i].pull);
            _tx(
                to,
                string.concat("setRouter(", vm.toString(cfg.routers[i].router), ", pull ", _n(cfg.routers[i].pull), ")")
            );
        }
        for (uint256 i; i < cfg.closedDays.length; ++i) {
            factory.setClosedDay(cfg.closedDays[i], true);
            _tx(to, string.concat("setClosedDay(", _n(cfg.closedDays[i]), ", closed)"));
        }
    }

    function readConfig(string memory path) public view returns (Config memory cfg) {
        return parseConfig(vm.readFile(path));
    }

    /// Every number is held to the size of the field it goes into: a value that does not fit is refused, not
    /// cut down (a `pull` of 257 would otherwise be read as 1).
    function parseConfig(string memory json) public view returns (Config memory cfg) {
        cfg.placeholders = _contains(bytes(json), "TODO");
        if (vm.keyExistsJson(json, ".timelock")) {
            cfg.timelockOwner = json.readAddress(".timelock.owner");
            cfg.timelockDelay = json.readUint(".timelock.delay");
        }
        cfg.keeperEnabled = vm.keyExistsJson(json, ".keeperEnabled") && json.readBool(".keeperEnabled");
        cfg.safeMinThreshold =
            vm.keyExistsJson(json, ".safeMinThreshold") ? json.readUint(".safeMinThreshold") : MIN_SAFE_THRESHOLD;
        cfg.openToAll = vm.keyExistsJson(json, ".openToAll") && json.readBool(".openToAll");
        uint256 creators = _count(json, ".creators");
        cfg.creators = new address[](creators);
        for (uint256 i; i < creators; ++i) {
            cfg.creators[i] = json.readAddress(string.concat(".creators[", vm.toString(i), "]"));
        }
        if (vm.keyExistsJson(json, ".depositCaps")) {
            cfg.hasCaps = true;
            cfg.vaultCap = json.readUint(".depositCaps.perVault");
            cfg.totalCap = json.readUint(".depositCaps.total");
        }
        if (vm.keyExistsJson(json, ".sessionPriceAge")) {
            cfg.sessionPriceAge = uint32(_fit(json, ".sessionPriceAge", type(uint32).max));
        }
        cfg.chainId = json.readUint(".chainId");
        cfg.adminIsDeployer = vm.keyExistsJson(json, ".adminIsDeployer") && json.readBool(".adminIsDeployer");
        cfg.admin = json.readAddress(".admin");
        cfg.guardian = json.readAddress(".guardian");
        cfg.keeper = json.readAddress(".keeper");
        cfg.sequencerFeed = json.readAddress(".sequencerFeed");
        cfg.publishDelay = uint32(_fit(json, ".publishDelay", type(uint32).max));
        cfg.params = Params({
            toleranceBps: uint16(_fit(json, ".params.toleranceBps", type(uint16).max)),
            lossCapBps: uint16(_fit(json, ".params.lossCapBps", type(uint16).max)),
            bandBps: uint16(_fit(json, ".params.bandBps", type(uint16).max)),
            assetCooldown: uint32(_fit(json, ".params.assetCooldown", type(uint32).max)),
            sessionOpen: uint32(_fit(json, ".params.sessionOpen", type(uint32).max)),
            sessionClose: uint32(_fit(json, ".params.sessionClose", type(uint32).max))
        });
        cfg.priceDevBps = uint16(_fit(json, ".priceDevBps", type(uint16).max));
        cfg.cashToken = json.readAddress(".cashToken");

        uint256 n = _count(json, ".assets");
        cfg.assets = new Asset[](n);
        cfg.feedDescriptions = new string[](n);
        for (uint256 i; i < n; ++i) {
            string memory entry = string.concat(".assets[", vm.toString(i), "]");
            cfg.assets[i].token = json.readAddress(string.concat(entry, ".token"));
            if (vm.keyExistsJson(json, string.concat(entry, ".feedDescription"))) {
                cfg.feedDescriptions[i] = json.readString(string.concat(entry, ".feedDescription"));
            }
            cfg.assets[i].config = AssetConfig({
                feed: json.readAddress(string.concat(entry, ".feed")),
                tokenDecimals: uint8(_fit(json, string.concat(entry, ".tokenDecimals"), type(uint8).max)),
                feedDecimals: uint8(_fit(json, string.concat(entry, ".feedDecimals"), type(uint8).max)),
                maxAge: uint32(_fit(json, string.concat(entry, ".maxAge"), type(uint32).max)),
                session: uint8(_fit(json, string.concat(entry, ".session"), type(uint8).max)),
                source: uint8(_fit(json, string.concat(entry, ".source"), type(uint8).max)),
                maxWeightBps: uint16(_fit(json, string.concat(entry, ".maxWeightBps"), type(uint16).max)),
                pauseProbe: json.readAddress(string.concat(entry, ".pauseProbe")),
                pauseSelector: _selector(json, string.concat(entry, ".pauseSelector")),
                scheduleSelector: _selector(json, string.concat(entry, ".scheduleSelector")),
                haltUntil: 0,
                flags: uint8(_fit(json, string.concat(entry, ".flags"), type(uint8).max)),
                averageFeed: json.readAddress(string.concat(entry, ".averageFeed")),
                minPrice: uint128(_fit(json, string.concat(entry, ".minPrice"), type(uint128).max)),
                maxPrice: uint128(_fit(json, string.concat(entry, ".maxPrice"), type(uint128).max))
            });
        }

        n = _count(json, ".routers");
        cfg.routers = new Router[](n);
        for (uint256 i; i < n; ++i) {
            string memory entry = string.concat(".routers[", vm.toString(i), "]");
            cfg.routers[i] = Router({
                router: json.readAddress(string.concat(entry, ".router")),
                pull: uint8(_fit(json, string.concat(entry, ".pull"), type(uint8).max))
            });
        }

        n = _count(json, ".closedDays");
        cfg.closedDays = new uint32[](n);
        for (uint256 i; i < n; ++i) {
            string memory entry = string.concat(".closedDays[", vm.toString(i), "]");
            cfg.closedDays[i] = uint32(_fit(json, entry, type(uint32).max));
        }
    }

    /// Whether `text` holds `word` anywhere.
    function _contains(bytes memory text, bytes memory word) private pure returns (bool) {
        if (word.length == 0 || text.length < word.length) return false;
        for (uint256 i; i <= text.length - word.length; ++i) {
            uint256 j;
            while (j < word.length && text[i + j] == word[j]) ++j;
            if (j == word.length) return true;
        }
        return false;
    }

    function _path() private view returns (string memory) {
        return vm.envOr("DEPLOY_CONFIG", string.concat("script/config/", vm.toString(block.chainid), ".json"));
    }

    /// One transaction of the run, printed as it is made: its number, its target and what it does.
    function _tx(address to, string memory what) private {
        ++sent;
        console2.log(string.concat("tx ", _n(sent), "  ", vm.toString(to), "  ", what));
    }

    function _n(uint256 value) private pure returns (string memory) {
        return vm.toString(value);
    }

    function _count(string memory json, string memory list) private view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(list, "[", vm.toString(n), "]"))) ++n;
    }

    function _fit(string memory json, string memory key, uint256 most) private pure returns (uint256 value) {
        value = json.readUint(key);
        require(value <= most, ValueDoesNotFit(key, value, most));
    }

    /// A selector is exactly four bytes.
    function _selector(string memory json, string memory key) private pure returns (bytes4) {
        bytes memory raw = json.readBytes(key);
        require(raw.length == 4, ValueDoesNotFit(key, raw.length, 4));
        return bytes4(raw);
    }

    /// What the timelock's owner says of itself, for a person to hold against the Safe they expect.
    function _printSafe(address safe) private view {
        try this.checkSafe(safe, 0) returns (uint256 threshold, address[] memory owners) {
            console2.log("  signatures it needs:", threshold);
            console2.log("  owners:", owners.length);
            for (uint256 i; i < owners.length; ++i) {
                console2.log("   ", owners[i]);
            }
            console2.log("  compare these owners and this threshold with the Safe you mean, before anything else");
        } catch {
            console2.log("  it does not answer as a Safe of two or more owners (allowed on a test network only)");
        }
    }

    function _print(Config memory cfg, Deployed memory d, address deployer) private view {
        console2.log("transactions:", sent);
        console2.log("chain id:", block.chainid);
        console2.log("deployer:", deployer);
        console2.log("vault logic:    ", d.vaultLogic);
        console2.log("beacon:         ", d.beacon);
        console2.log("factory logic:  ", d.factoryLogic);
        console2.log("factory (proxy):", d.factory);
        console2.log("registry logic: ", d.registryLogic);
        console2.log("registry (proxy):", d.registry);
        console2.log("guardian:", cfg.guardian);
        console2.log("keeper:  ", cfg.keeper);
        console2.log("cash token:", cfg.cashToken);
        console2.log("assets listed:", cfg.assets.length);
        console2.log("routers allowed:", cfg.routers.length);
        console2.log("closed days set:", cfg.closedDays.length);
        console2.log("publish delay, seconds:", uint256(cfg.publishDelay));
        (uint256 perVault, uint256 total) = VaultFactory(d.factory).depositCaps();
        console2.log("deposit cap, one vault:", perVault);
        console2.log("deposit cap, all vaults:", total);
        if (d.timelock != address(0)) {
            console2.log("timelock (admin and beacon owner):", d.timelock);
            console2.log("timelock delay, seconds:", cfg.timelockDelay);
            console2.log("timelock proposer, canceller, executor:", cfg.timelockOwner);
            _printSafe(cfg.timelockOwner);
            console2.log(
                "the deployer holds nothing. Write deployments/<network>.json from this and run authority-check"
            );
        } else if (cfg.admin == deployer) {
            console2.log("admin and beacon owner: the deployer");
        } else {
            console2.log("admin and beacon owner now: the deployer");
            console2.log("proposed for both:", cfg.admin);
            console2.log("still to do, by that key: factory.acceptAdmin() and beacon.acceptOwnership()");
        }
    }
}
