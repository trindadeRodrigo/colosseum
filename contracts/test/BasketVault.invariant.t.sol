// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {IBasketVault} from "../src/interfaces/IBasketVault.sol";
import {PERMIT2} from "../src/interfaces/IVaultConfig.sol";
import {Swap, Weight} from "../src/interfaces/Types.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {VaultFixture} from "./helpers/VaultFixture.sol";
import {MockPermit2, MockRouter} from "./mocks/Routers.sol";
import {BackdoorToken, MockToken, NoReturnToken} from "./mocks/Tokens.sol";

interface IBalance {
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// Drives one vault with its owner, a donor, two routers, the guardian, and callers that are not the owner.
/// It records any token that left the vault in a way the rules do not allow: by a call that was not the
/// owner's, to anyone but the owner, or into a swap for more than the owner signed.
contract VaultHandler is Test {
    BasketVault internal vault;
    VaultFactory internal factory;
    address internal owner;
    address internal admin;
    address internal guardian;
    address internal attacker;
    address[] internal tokens;
    MockRouter[] internal routers;
    /// The addresses a hostile call is most likely to come from: the factory, the registry, the beacon, the
    /// logic contract, the three roles, the routers, Permit2, a funded stranger, the vault itself. Any other
    /// address is tried too.
    address[] internal insiders;

    /// Set when a token left the vault in a way the rules do not allow.
    bool public leaked;
    uint256 public deposits;
    uint256 public withdrawals;
    uint256 public sweeps;
    uint256 public swaps;
    uint256 public swapsThatLeftSomeUnused;
    uint256 public hostileSwaps;
    uint256 public batches;
    uint256 public targetSets;
    uint256 public namedCalls;
    uint256 public rawCalls;
    uint256 public donations;
    uint256 public tightenings;
    uint256 public strangerVaults;

    constructor(
        BasketVault vault_,
        VaultFactory factory_,
        address[4] memory people,
        address[] memory tokens_,
        MockRouter[] memory routers_,
        address[] memory insiders_
    ) {
        vault = vault_;
        factory = factory_;
        (owner, admin, guardian, attacker) = (people[0], people[1], people[2], people[3]);
        tokens = tokens_;
        routers = routers_;
        insiders = insiders_;
    }

    /// What the vault and the owner hold of every token.
    function _held() internal view returns (uint256[] memory inVault, uint256[] memory withOwner) {
        inVault = new uint256[](tokens.length);
        withOwner = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            inVault[i] = IBalance(tokens[i]).balanceOf(address(vault));
            withOwner[i] = IBalance(tokens[i]).balanceOf(owner);
        }
    }

    /// A call that is not a swap: whatever left the vault left by the owner's call and reached the owner.
    modifier watched(address caller) {
        (uint256[] memory inVault, uint256[] memory withOwner) = _held();
        _;
        for (uint256 i; i < tokens.length; ++i) {
            uint256 left = IBalance(tokens[i]).balanceOf(address(vault));
            if (left >= inVault[i]) continue;
            uint256 gone = inVault[i] - left;
            if (caller != owner || IBalance(tokens[i]).balanceOf(owner) != withOwner[i] + gone) leaked = true;
        }
    }

    /// A call that must change nothing the vault holds.
    modifier unchanged() {
        (uint256[] memory inVault,) = _held();
        _;
        for (uint256 i; i < tokens.length; ++i) {
            if (IBalance(tokens[i]).balanceOf(address(vault)) != inVault[i]) leaked = true;
        }
    }

    // ---- the owner

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

    /// An honest swap through either router. The router may take less than it was approved for
    /// (`usedBps`), which is how an allowance would be left behind if the vault did not take it back.
    function ownerSwap(uint256 routerSeed, uint256 inSeed, uint256 outSeed, uint256 amountIn, uint256 usedBps)
        external
    {
        _fund(inSeed);
        (Swap memory s, uint256 used, uint256 paid) = _honestSwap(routerSeed, inSeed, outSeed, amountIn, usedBps);
        (uint256[] memory inVault,) = _held();
        Swap[] memory list = new Swap[](1);
        list[0] = s;
        vm.prank(owner);
        vault.ownerSwap(list);
        _assertSwapped(s, inVault, used, paid);
        ++swaps;
        if (used < s.amountIn) ++swapsThatLeftSomeUnused;
    }

    /// The owner signs a swap whose router cheats, one way per call. Every one of them must fail and leave
    /// the vault as it was.
    function ownerSwapWithACheatingRouter(
        uint256 modeSeed,
        uint256 routerSeed,
        uint256 inSeed,
        uint256 outSeed,
        uint256 amountIn
    ) external {
        // The token that is neither side of the trade. The vault holds a unit of it and tracks it, and holds
        // one unit of the input more than the swap may spend, so that there is something to take.
        address third = _third(inSeed, outSeed);
        MockToken(third).mint(address(vault), 1);
        vm.prank(admin);
        factory.setCashToken(third);
        vm.prank(owner);
        vault.deposit(0);
        _fund(inSeed);
        (Swap memory s,, uint256 paid) = _honestSwap(routerSeed, inSeed, outSeed, amountIn, 10_000);
        MockToken(s.tokenIn).mint(address(vault), 1);

        uint256 mode = modeSeed % 6;
        if (mode == 0) {
            // Pays one unit less than the owner's minimum.
            s.minOut = paid + 1;
        } else if (mode == 1) {
            // A1: pays someone else.
            s.data = abi.encodeCall(MockRouter.swapTo, (s.tokenIn, s.tokenOut, s.amountIn, paid, attacker));
        } else if (mode == 2) {
            // Takes one unit more of the input than was approved, through the token's back door.
            s.data = abi.encodeCall(MockRouter.swapAndSeize, (s.tokenIn, s.tokenOut, s.amountIn, paid, s.tokenIn, 1));
        } else if (mode == 3) {
            // Takes a token that was no part of the trade.
            s.data = abi.encodeCall(MockRouter.swapAndSeize, (s.tokenIn, s.tokenOut, s.amountIn, paid, third, 1));
        } else if (mode == 4) {
            // A17: calls back into the vault mid-swap.
            s.data = abi.encodeCall(
                MockRouter.swapAndCall,
                (s.tokenIn, s.tokenOut, s.amountIn, paid, address(vault), abi.encodeCall(BasketVault.withdrawAll, ()))
            );
        } else {
            // A token as the "router", with an approval as its "swap".
            s.router = third;
            s.data = abi.encodeWithSignature("approve(address,uint256)", attacker, type(uint256).max);
        }
        _mustFail(s);
        ++hostileSwaps;
    }

    function _mustFail(Swap memory s) internal unchanged {
        Swap[] memory list = new Swap[](1);
        list[0] = s;
        vm.prank(owner);
        (bool ok,) = address(vault).call(abi.encodeCall(BasketVault.ownerSwap, (list)));
        assertFalse(ok, "a swap through a cheating router went through");
    }

    /// A deposit and a swap in one `multicall`.
    function ownerBatch(uint256 tokenSeed, uint256 deposit, uint256 routerSeed, uint256 outSeed, uint256 usedBps)
        external
    {
        address token = tokens[tokenSeed % tokens.length];
        deposit = bound(deposit, 0, IBalance(token).balanceOf(owner));
        vm.prank(admin);
        factory.setCashToken(token);
        (uint256[] memory inVault,) = _held();
        inVault[tokenSeed % tokens.length] += deposit;

        Swap[] memory list = new Swap[](1);
        uint256 used;
        uint256 paid;
        (list[0], used, paid) = _swapOf(routerSeed, tokenSeed, outSeed, inVault[tokenSeed % tokens.length], usedBps);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(BasketVault.deposit, (deposit));
        calls[1] = abi.encodeCall(BasketVault.ownerSwap, (list));
        vm.prank(owner);
        vault.multicall(calls);
        _assertSwapped(list[0], inVault, used, paid);
        ++batches;
    }

    function ownerSetTargets(uint256 firstBps, uint256 secondBps) external unchanged {
        // Whatever is the cash token now cannot be a target; the other two can.
        address cash = factory.cashToken();
        Weight[] memory targets = new Weight[](2);
        uint256 n;
        for (uint256 i; i < tokens.length && n < 2; ++i) {
            if (tokens[i] != cash) targets[n++] = Weight(tokens[i], 0);
        }
        if (targets[0].token > targets[1].token) (targets[0], targets[1]) = (targets[1], targets[0]);
        targets[0].bps = uint16(bound(firstBps, 0, 10_000));
        targets[1].bps = uint16(bound(secondBps, 0, 10_000 - targets[0].bps));
        vm.prank(owner);
        vault.setTargets(targets);
        ++targetSets;
    }

    // ---- everyone else

    /// Anyone but the owner tries each entry point by name, and the recipient-taking shapes the rig had.
    /// Every one of them must fail.
    function strangerNamedCall(uint256 callerSeed, address anyone, uint256 callSeed, uint256 tokenSeed, uint256 amount)
        external
    {
        address caller = _notTheOwner(callerSeed, anyone);
        address token = tokens[tokenSeed % tokens.length];
        amount = bound(amount, 0, IBalance(token).balanceOf(address(vault)));
        Swap[] memory list = new Swap[](1);
        (list[0],,) = _swapOf(callerSeed, tokenSeed, tokenSeed % tokens.length + 1, amount, 10_000);
        bytes[] memory batch = new bytes[](1);
        batch[0] = abi.encodeCall(BasketVault.withdraw, (token, amount));
        bytes[11] memory calls = [
            abi.encodeCall(BasketVault.withdraw, (token, amount)),
            abi.encodeCall(BasketVault.withdrawAll, ()),
            abi.encodeCall(BasketVault.deposit, (amount)),
            abi.encodeCall(BasketVault.initialize, (caller, bytes32(0))),
            abi.encodeCall(BasketVault.start, (bytes32(0), 0, new Weight[](0), amount, list)),
            abi.encodeCall(BasketVault.ownerSwap, (list)),
            abi.encodeCall(BasketVault.setTargets, (new Weight[](0))),
            abi.encodeCall(IBasketVault.multicall, (batch)),
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
        bytes4[12] memory selectors = [
            BasketVault.withdraw.selector,
            BasketVault.withdrawAll.selector,
            BasketVault.deposit.selector,
            BasketVault.initialize.selector,
            BasketVault.start.selector,
            BasketVault.ownerSwap.selector,
            BasketVault.setTargets.selector,
            IBasketVault.multicall.selector,
            BasketVault.owner.selector,
            BasketVault.tokens.selector,
            bytes4(0),
            bytes4(0)
        ];
        bytes4 selector = selectors[selectorSeed % selectors.length];
        address ownerBefore = vault.owner();
        address configBefore = vault.config();
        uint256 listBefore = vault.tokens().length;
        bytes32 targetsBefore = keccak256(abi.encode(vault.targets()));

        _callAs(caller, selector == bytes4(0) ? data : bytes.concat(selector, data));

        assertEq(vault.owner(), ownerBefore);
        assertEq(vault.config(), configBefore);
        assertEq(vault.tokens().length, listBefore);
        assertEq(keccak256(abi.encode(vault.targets())), targetsBefore);
        ++rawCalls;
    }

    /// A stranger asks the factory for a vault under the owner's plan id. They get one of their own, and
    /// the owner's is untouched.
    function strangerCreatesAVault(uint256 callerSeed, address anyone) external unchanged {
        address caller = _notTheOwner(callerSeed, anyone);
        bytes32 planId = vault.planId();
        if (factory.vaultOf(caller, planId).code.length != 0) return;
        vm.prank(caller);
        address made = factory.createVault(planId, new Weight[](0), bytes32(0), 0, false);
        assertTrue(made != address(vault));
        assertEq(BasketVault(made).owner(), caller);
        ++strangerVaults;
    }

    /// Tokens arriving from outside (A10's shape) are the owner's to withdraw and nobody else's.
    function donate(uint256 tokenSeed, uint256 amount) external {
        address token = tokens[tokenSeed % tokens.length];
        MockToken(token).mint(address(vault), bound(amount, 0, 1e30));
        ++donations;
    }

    /// The guardian pauses, halts and closes. None of it is the owner's concern: with fail-on-revert on,
    /// every owner call after this still has to go through.
    function guardianTightens(uint256 seed, uint256 tokenSeed) external unchanged {
        address token = tokens[tokenSeed % tokens.length];
        vm.startPrank(guardian);
        if (seed % 4 == 0) factory.pauseKeeper();
        else if (seed % 4 == 1) factory.haltAsset(token, factory.asset(token).haltUntil + 1 days);
        else if (seed % 4 == 2) factory.extendClosedUntil(factory.closedUntil() + 1 days);
        else factory.addClosedDay(uint32(seed >> 8));
        vm.stopPrank();
        ++tightenings;
    }

    // ---- internals

    function _honestSwap(uint256 routerSeed, uint256 inSeed, uint256 outSeed, uint256 amountIn, uint256 usedBps)
        internal
        view
        returns (Swap memory s, uint256 used, uint256 paid)
    {
        uint256 has = IBalance(tokens[inSeed % tokens.length]).balanceOf(address(vault));
        return _swapOf(routerSeed, inSeed, outSeed, bound(amountIn, 0, has), usedBps);
    }

    /// A swap of nothing shows nothing: an empty vault is given something to trade first, as a donation.
    function _fund(uint256 inSeed) internal {
        address token = tokens[inSeed % tokens.length];
        if (IBalance(token).balanceOf(address(vault)) == 0) MockToken(token).mint(address(vault), 1e24);
    }

    /// A swap of up to `amountIn` of one token for another through one of the routers, which uses `usedBps`
    /// of what it is approved for and pays a made-up price.
    function _swapOf(uint256 routerSeed, uint256 inSeed, uint256 outSeed, uint256 amountIn, uint256 usedBps)
        internal
        view
        returns (Swap memory s, uint256 used, uint256 paid)
    {
        MockRouter router = routers[routerSeed % routers.length];
        address tokenIn = tokens[inSeed % tokens.length];
        address tokenOut = tokens[outSeed % tokens.length];
        if (tokenOut == tokenIn) tokenOut = tokens[(outSeed % tokens.length + 1) % tokens.length];
        used = amountIn * bound(usedBps, 0, 10_000) / 10_000;
        paid = used / 3 + 1;
        s = Swap({
            router: address(router),
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minOut: paid,
            data: abi.encodeCall(MockRouter.swap, (tokenIn, tokenOut, used, paid))
        });
    }

    /// Of the three tokens, the one a swap between the other two does not touch.
    function _third(uint256 inSeed, uint256 outSeed) internal view returns (address) {
        uint256 i = inSeed % tokens.length;
        uint256 o = outSeed % tokens.length;
        if (o == i) o = (o + 1) % tokens.length;
        return tokens[3 - i - o];
    }

    /// I1 for a swap: the input fell by what the router used and no more than the owner signed, the output
    /// rose by what was paid, and every other token is where it was.
    function _assertSwapped(Swap memory s, uint256[] memory inVault, uint256 used, uint256 paid) internal {
        for (uint256 i; i < tokens.length; ++i) {
            uint256 left = IBalance(tokens[i]).balanceOf(address(vault));
            if (tokens[i] == s.tokenIn) {
                if (left != inVault[i] - used || used > s.amountIn) leaked = true;
            } else if (tokens[i] == s.tokenOut) {
                if (left != inVault[i] + paid) leaked = true;
            } else if (left != inVault[i]) {
                leaked = true;
            }
        }
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

/// I1: tokens leave a vault only by the owner's call: to the owner, or as the input of a swap the owner
/// signed and for no more than its `amountIn`.
/// I3: no allowance from the vault survives any sequence of calls, on a token or inside Permit2.
contract BasketVaultInvariantTest is VaultFixture {
    VaultHandler internal handler;
    address internal attacker = makeAddr("attacker");
    address[] internal tokens;
    MockRouter[] internal routers;
    address[] internal insiders;
    /// Everyone an allowance could have been left to.
    address[] internal spenders;

    function setUp() public {
        _deployPlatform();
        tokens.push(address(new BackdoorToken(6)));
        tokens.push(address(new BackdoorToken(18)));
        tokens.push(address(new NoReturnToken(8)));
        routers.push(new MockRouter(false));
        routers.push(new MockRouter(true));
        vm.startPrank(admin);
        factory.setRouter(address(routers[0]), 1);
        factory.setRouter(address(routers[1]), 2);
        vm.stopPrank();

        insiders.push(address(factory));
        insiders.push(address(registry));
        insiders.push(address(beacon));
        insiders.push(address(logic));
        insiders.push(admin);
        insiders.push(guardian);
        insiders.push(keeper);
        insiders.push(address(routers[0]));
        insiders.push(address(routers[1]));
        insiders.push(PERMIT2);
        insiders.push(attacker);
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
            // The routers' reserves.
            MockToken(tokens[i]).mint(address(routers[0]), 1e40);
            MockToken(tokens[i]).mint(address(routers[1]), 1e40);
        }

        handler = new VaultHandler(vault, factory, [owner, admin, guardian, attacker], tokens, routers, insiders);
        for (uint256 i; i < insiders.length; ++i) {
            spenders.push(insiders[i]);
        }
        spenders.push(address(handler));
        spenders.push(owner);

        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = VaultHandler.ownerDeposit.selector;
        selectors[1] = VaultHandler.ownerWithdraw.selector;
        selectors[2] = VaultHandler.ownerWithdrawAll.selector;
        selectors[3] = VaultHandler.ownerSwap.selector;
        selectors[4] = VaultHandler.ownerSwapWithACheatingRouter.selector;
        selectors[5] = VaultHandler.ownerBatch.selector;
        selectors[6] = VaultHandler.ownerSetTargets.selector;
        selectors[7] = VaultHandler.strangerNamedCall.selector;
        selectors[8] = VaultHandler.strangerRawCall.selector;
        selectors[9] = VaultHandler.strangerCreatesAVault.selector;
        selectors[10] = VaultHandler.donate.selector;
        selectors[11] = VaultHandler.guardianTightens.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_I1_tokensLeaveOnlyByTheOwnersCall() public view {
        assertFalse(handler.leaked(), "a token left the vault by another way");
        assertEq(vault.owner(), owner);
        assertEq(vault.config(), address(factory));
        assertEq(factory.vaultOf(owner, PLAN_ID), address(vault));
        assertEq(factory.vaultsOf(owner).length, 1);
        for (uint256 i; i < tokens.length; ++i) {
            IBalance token = IBalance(tokens[i]);
            // The stranger never got in, and nobody who is not the owner or a router ended up with a token.
            assertEq(token.balanceOf(stranger), 1e30);
            assertEq(token.balanceOf(attacker), 0);
            assertEq(token.balanceOf(address(factory)), 0);
            assertEq(token.balanceOf(address(registry)), 0);
            assertEq(token.balanceOf(keeper), 0);
            assertEq(token.balanceOf(PERMIT2), 0);
            // Every unit is with the owner, in the vault, with a router, or still with that stranger.
            assertEq(
                token.balanceOf(owner) + token.balanceOf(address(vault)) + token.balanceOf(address(routers[0]))
                    + token.balanceOf(address(routers[1])) + 1e30,
                token.totalSupply()
            );
        }
    }

    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_I3_noAllowanceSurvives() public view {
        for (uint256 i; i < tokens.length; ++i) {
            for (uint256 j; j < spenders.length; ++j) {
                assertEq(IBalance(tokens[i]).allowance(address(vault), spenders[j]), 0, "an allowance on a token");
                (uint160 inPermit2,,) = MockPermit2(PERMIT2).allowance(address(vault), tokens[i], spenders[j]);
                assertEq(inPermit2, 0, "an allowance inside Permit2");
            }
        }
    }

    /// A run where nothing happened would prove nothing. With `fail-on-revert` on, every call counted here
    /// went through as the handler meant it to: the owner's succeeded and the others' were refused. Which of
    /// the twelve actions a run of 100 calls draws is chance, so a run is held to having drawn some of each
    /// kind; `test_handler_everyActionDoesWhatItSays` shows each action on its own.
    function afterInvariant() public view {
        assertGt(
            handler.deposits() + handler.withdrawals() + handler.sweeps() + handler.swaps() + handler.batches()
                + handler.targetSets(),
            0,
            "the owner did nothing"
        );
        assertGt(
            handler.namedCalls() + handler.rawCalls() + handler.strangerVaults() + handler.hostileSwaps(),
            0,
            "nobody tried to get in"
        );
    }

    /// Every action of the handler once, in an order that gives each something to do, with both invariants
    /// checked after each. A handler whose calls quietly did nothing would pass the invariants and prove
    /// nothing; this shows each one counted.
    function test_handler_everyActionDoesWhatItSays() public {
        handler.ownerDeposit(0, 1000e6);
        handler.ownerSwap(0, 0, 1, 600e6, 10_000);
        handler.ownerSwap(1, 0, 2, 300e6, 5000);
        _holds();
        assertEq(handler.swaps(), 2);
        assertEq(handler.swapsThatLeftSomeUnused(), 1, "a router that took half of what it was approved for");
        assertEq(IBalance(tokens[0]).balanceOf(address(vault)), 250e6);
        assertEq(IBalance(tokens[1]).balanceOf(address(vault)), 200e6 + 1);
        assertEq(IBalance(tokens[2]).balanceOf(address(vault)), 50e6 + 1);

        for (uint256 mode; mode < 6; ++mode) {
            handler.ownerSwapWithACheatingRouter(mode, mode, 0, 1, 100e6);
            _holds();
        }
        assertEq(handler.hostileSwaps(), 6);

        handler.ownerBatch(1, 500e18, 1, 2, 9000);
        handler.ownerSetTargets(6000, 9000);
        assertEq(vault.targets().length, 2);
        for (uint256 call; call < 11; ++call) {
            handler.strangerNamedCall(call, stranger, call, call, 1e6);
        }
        handler.strangerRawCall(11, stranger, 0, abi.encode(tokens[0], 1));
        handler.strangerCreatesAVault(11, stranger);
        handler.donate(2, 5e8);
        for (uint256 kind; kind < 4; ++kind) {
            handler.guardianTightens(kind, kind);
        }
        assertTrue(factory.keeperPaused());
        handler.ownerWithdraw(0, 1e6);
        handler.ownerWithdrawAll();
        _holds();

        assertEq(handler.deposits(), 1);
        assertEq(handler.batches(), 1);
        assertEq(handler.targetSets(), 1);
        assertEq(handler.namedCalls(), 11);
        assertEq(handler.rawCalls(), 1);
        assertEq(handler.strangerVaults(), 1);
        assertEq(handler.donations(), 1);
        assertEq(handler.tightenings(), 4);
        assertEq(handler.withdrawals(), 1);
        assertEq(handler.sweeps(), 1);
        for (uint256 i; i < tokens.length; ++i) {
            assertEq(IBalance(tokens[i]).balanceOf(address(vault)), 0, "the owner took everything out");
        }
    }

    function _holds() internal view {
        invariant_I1_tokensLeaveOnlyByTheOwnersCall();
        invariant_I3_noAllowanceSurvives();
    }
}
