// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";

/// Every function each contract can be called with, and why it is there. A test per contract reads the built
/// ABI and fails when a function is added, removed or renamed, or when a `fallback` or a `receive` appears.
/// So adding an entry point means adding a line here, and with it looking at what the new function can move.
contract EntryPointsTest is Test {
    string[] internal expected;

    /// One entry point and the reason it exists. An entry with no reason is refused.
    function _entry(string memory signature, string memory why) internal {
        assertGt(bytes(why).length, 0, signature);
        expected.push(signature);
    }

    function _assertExactly(string memory name) internal view {
        string memory artifact = vm.readFile(string.concat("out/", name, ".sol/", name, ".json"));
        string[] memory found = vm.parseJsonKeys(artifact, ".methodIdentifiers");
        for (uint256 i; i < found.length; ++i) {
            assertTrue(
                _listed(found[i]), string.concat(name, " has an entry point that is not listed here: ", found[i])
            );
        }
        for (uint256 i; i < expected.length; ++i) {
            bool present;
            for (uint256 j; j < found.length; ++j) {
                if (keccak256(bytes(found[j])) == keccak256(bytes(expected[i]))) present = true;
            }
            assertTrue(present, string.concat(name, " no longer has: ", expected[i]));
        }
        assertEq(found.length, expected.length, "an entry point is listed twice");

        uint256 entries;
        for (;; ++entries) {
            string memory entry = string.concat(".abi[", vm.toString(entries), "]");
            if (!vm.keyExistsJson(artifact, entry)) break;
            bytes32 kind = keccak256(bytes(vm.parseJsonString(artifact, string.concat(entry, ".type"))));
            assertTrue(kind != keccak256("fallback"), string.concat(name, " has a fallback"));
            assertTrue(kind != keccak256("receive"), string.concat(name, " has a receive"));
        }
        assertGt(entries, expected.length, "the ABI was not read");
    }

    function _listed(string memory signature) internal view returns (bool) {
        for (uint256 i; i < expected.length; ++i) {
            if (keccak256(bytes(expected[i])) == keccak256(bytes(signature))) return true;
        }
        return false;
    }

    /// I1, stated as the whole surface of a vault. No function takes a recipient. Tokens leave by
    /// `withdraw`, `withdrawAll` and as the input of `ownerSwap`, each the owner's call; `start` can spend
    /// only what the owner sent the factory in the creating transaction; `keeperSwap` spends only toward
    /// the owner's targets, under the checks of section 5, and is paid back into the vault.
    function test_I1_entryPoints_areExactlyThese() public {
        _entry(
            "initialize(address,bytes32)",
            "the factory, inside the proxy's constructor: fixes the owner, the plan and the config"
        );
        _entry(
            "start(bytes32,uint32,(address,uint16)[],bool,uint256,(address,address,address,uint256,uint256,bytes)[])",
            "the factory, in the creating transaction only: targets or the followed portfolio, auto-follow, the first deposit and swaps"
        );
        _entry("deposit(uint256)", "the owner puts the cash token in");
        _entry("withdraw(address,uint256)", "the owner takes any token out, to the owner");
        _entry("withdrawAll()", "the owner takes every tracked token out, to the owner");
        _entry(
            "ownerSwap((address,address,address,uint256,uint256,bytes)[],uint64)",
            "the owner trades through an allowed router, judged by the vault's balances, until a deadline"
        );
        _entry("setTargets((address,uint16)[])", "the owner sets their own targets and stops following");
        _entry("acceptVersion(bytes32,uint32)", "the owner takes the version in effect of a shared portfolio");
        _entry("setAutoFollow(bool)", "the owner lets the keeper trade toward the targets, or stops it");
        _entry("adoptVersion()", "anyone, for an auto-follow vault: a newer version with no new asset");
        _entry(
            "keeperSwap((address,address,address,uint256,uint256,bytes))",
            "the config's keeper: cash for one target or back, under the checks of section 5"
        );
        _entry("multicall(bytes[])", "several of the above in one transaction; each inner call checks its caller");
        _entry("owner()", "view");
        _entry("planId()", "view: matches a vault to its plan with no event");
        _entry("config()", "view: the factory that created it");
        _entry("tokens()", "view: what withdrawAll walks");
        _entry("netDeposited()", "view: cash in less cash out, what the deposit caps count");
        _entry("targets()", "view: the targets held");
        _entry("following()", "view: the shared portfolio, the accepted version, auto-follow");
        _entry("snapshot()", "view: one read of the vault for the app and for agents");
        _assertExactly("BasketVault");
    }

    /// The vault never implements ERC-1271. With it, a signature could stand for the vault: Permit2's
    /// signed allowance and a token's `permit` would both become usable against it from call data.
    function test_isValidSignature_isAbsent() public view {
        string memory artifact = vm.readFile("out/BasketVault.sol/BasketVault.json");
        string[] memory found = vm.parseJsonKeys(artifact, ".methodIdentifiers");
        for (uint256 i; i < found.length; ++i) {
            bytes4 selector = bytes4(keccak256(bytes(found[i])));
            assertTrue(selector != bytes4(keccak256("isValidSignature(bytes32,bytes)")), "ERC-1271 on the vault");
            assertTrue(selector != bytes4(keccak256("isValidSignature(bytes,bytes)")), "the older ERC-1271 form");
        }
    }

    function test_entryPoints_ofTheFactory_areExactlyThese() public {
        // creation: anyone, for themselves
        _entry("createVault(bytes32,(address,uint16)[],bytes32,uint32,bool)", "anyone creates their own vault");
        _entry(
            "createVaultAndBuy(bytes32,(address,uint16)[],bytes32,uint32,bool,uint256,(address,address,address,uint256,uint256,bytes)[],uint64)",
            "the same, with the first deposit and swaps in one transaction, until a deadline"
        );
        // finding vaults with no event
        _entry("vaultOf(address,bytes32)", "view: the address of a vault, before or after it exists");
        _entry("isVault(address)", "view: whether this factory created it");
        _entry("vaultCount()", "view");
        _entry("vaultAt(uint256)", "view: every vault, for the keeper");
        _entry("vaultsOf(address)", "view: one owner's vaults, for the app");
        _entry("vaultCountOf(address)", "view: the same, paged");
        _entry("vaultOfAt(address,uint256)", "view: the same, paged");
        _entry("beacon()", "view: where every vault reads its logic");
        // set-up and upgrade
        _entry(
            "initialize(address,address,(uint16,uint16,uint16,uint32,uint32,uint32))",
            "once, in the proxy's constructor"
        );
        _entry("upgradeToAndCall(address,bytes)", "the admin replaces the factory's logic");
        _entry("proxiableUUID()", "UUPS: lets an upgrade check the new logic is a UUPS one");
        _entry("UPGRADE_INTERFACE_VERSION()", "UUPS: a constant tools read");
        // admin
        _entry(
            "setAsset(address,(address,uint8,uint8,uint32,uint8,uint8,uint16,address,bytes4,bytes4,uint64,uint8,address,uint128,uint128))",
            "admin: list an asset or change its feeds, its range, its limits and the keeper's switch on it"
        );
        _entry("removeAsset(address)", "admin: take an asset off the list");
        _entry("setRouter(address,uint8)", "admin: allow or remove a router");
        _entry("setCashToken(address)", "admin: name the chain's dollar token");
        _entry("setRegistry(address)", "admin, once: the shared-portfolio registry");
        _entry("setKeeper(address)", "admin: rotate the keeper");
        _entry("setGuardian(address)", "admin: rotate the guardian");
        _entry("setSequencerFeed(address)", "admin: the chain's sequencer feed, if it has one");
        _entry(
            "setParams((uint16,uint16,uint16,uint32,uint32,uint32))", "admin: the keeper's limits, inside hard bounds"
        );
        _entry("setPriceDevBps(uint16)", "admin: how far a price may be from its average, inside a hard bound");
        _entry("unpauseKeeper()", "admin: lift the guardian's pause");
        _entry("unpauseDeposits()", "admin: lift the guardian's stop on new money");
        _entry("setDepositCaps(uint256,uint256)", "admin: the most one vault and all vaults may take in");
        _entry("setCreationRestricted(bool)", "admin: only the listed may create a vault, or anyone again");
        _entry("setCreator(address,bool)", "admin: put an address on that list, or take it off");
        _entry("setSessionPriceAge(uint32)", "admin: how old a stock's price may be in session, for the keeper");
        _entry("setHalt(address,uint64)", "admin: lift or shorten a halt");
        _entry("setClosedUntil(uint64)", "admin: lift or shorten a market closure");
        _entry("setClosedDay(uint32,bool)", "admin: add or remove a closed day");
        _entry("launch()", "admin, one-way: raises the publish delay's floor to 48 hours");
        _entry("proposeAdmin(address)", "admin: step one of a handover");
        _entry("acceptAdmin()", "the proposed admin: step two");
        // guardian: tighten only
        _entry("pauseKeeper()", "guardian: stop the keeper's path; the owner's is untouched");
        _entry("haltAsset(address,uint64)", "guardian: stop keeper trades in one asset, for longer only");
        _entry("extendClosedUntil(uint64)", "guardian: keep the market closed for longer");
        _entry("addClosedDay(uint32)", "guardian: add a closed day");
        _entry("pauseDeposits()", "guardian: stop new money; withdrawing is untouched");
        // a vault, about itself, and anyone, about a vault
        _entry("noteDeposit(uint256)", "a vault of this factory, inside its deposit: counted against the caps");
        _entry("syncDeposits(address[])", "anyone: lower a vault's count to what it reports now");
        // what a vault, the registry and the app read
        _entry("admin()", "view");
        _entry("pendingAdmin()", "view");
        _entry("cashToken()", "view: read by a vault on every deposit");
        _entry("asset(address)", "view: an asset's settings");
        _entry("assets()", "view: the list");
        _entry("isAsset(address)", "view: on the list now");
        _entry("wasAsset(address)", "view: on the list now or once, so still sellable");
        _entry("removedAssets()", "view");
        _entry("routerPull(address)", "view: read by a vault on every swap");
        _entry("registry()", "view: read by a vault when it follows a shared portfolio");
        _entry("keeper()", "view");
        _entry("guardian()", "view");
        _entry("sequencerFeed()", "view");
        _entry("keeperPaused()", "view");
        _entry("launched()", "view: read by the registry for the delay's floor");
        _entry("closedUntil()", "view");
        _entry("closedDay(uint32)", "view");
        _entry("params()", "view");
        _entry("priceDevBps()", "view: read by a vault on every keeper trade");
        _entry("sessionPriceAge()", "view: read by a vault on every keeper trade");
        _entry("depositCaps()", "view: the cap of one vault and of all of them");
        _entry("depositsPaused()", "view");
        _entry("creationRestricted()", "view");
        _entry("mayCreate(address)", "view: read by the factory on every create");
        _entry("totalDeposited()", "view: what counts toward the total cap");
        _entry("depositedOf(address)", "view: what counts for one vault");
        _assertExactly("VaultFactory");
    }

    function test_entryPoints_ofTheRegistry_areExactlyThese() public {
        _entry(
            "create(bytes32,(address,uint16)[],bytes32,uint16,uint8)",
            "anyone publishes version 1 of a shared portfolio"
        );
        _entry("publish(bytes32,(address,uint16)[],bytes32)", "the creator publishes a later version");
        _entry("cancel(bytes32)", "the creator or the guardian takes back the waiting version");
        _entry("setPublishDelay(uint32)", "the factory's admin sets the delay, above its floor");
        _entry("initialize(address,uint32)", "once, in the proxy's constructor");
        _entry("upgradeToAndCall(address,bytes)", "the factory's admin replaces the registry's logic");
        _entry("proxiableUUID()", "UUPS: lets an upgrade check the new logic is a UUPS one");
        _entry("UPGRADE_INTERFACE_VERSION()", "UUPS: a constant tools read");
        _entry("active(bytes32)", "view: the version in effect; read by a vault that follows");
        _entry("pending(bytes32)", "view: the version waiting");
        _entry("creatorOf(bytes32)", "view");
        _entry("indexInfo(bytes32)", "view: everything the app shows, in one read");
        _entry("indexCount()", "view");
        _entry("indexAt(uint256)", "view: every shared portfolio, with no event");
        _entry("previewPublish(bytes32,(address,uint16)[])", "view: what a publish would answer, before paying for it");
        _entry("limits()", "view: the numbers of the four limits");
        _entry("publishDelay()", "view: the delay in force");
        _entry("factory()", "view");
        _assertExactly("IndexRegistry");
    }

    function test_entryPoints_ofTheBeacon_areExactlyThese() public {
        _entry("upgradeTo(address)", "the owner replaces the logic of every vault");
        _entry("transferOwnership(address)", "the owner: step one of a handover");
        _entry("acceptOwnership()", "the proposed owner: step two");
        _entry("renounceOwnership()", "always reverts: the key cannot be given up");
        _entry("implementation()", "view: read by every vault on every call");
        _entry("owner()", "view");
        _entry("pendingOwner()", "view");
        _assertExactly("VaultBeacon");
    }
}
