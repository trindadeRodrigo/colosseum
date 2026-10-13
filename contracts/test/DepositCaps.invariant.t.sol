// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {Swap} from "../src/interfaces/Types.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {SwapFixture} from "./helpers/SwapFixture.sol";
import {MockRouter} from "./mocks/Routers.sol";
import {BackdoorToken} from "./mocks/Tokens.sol";

/// Three people, each with a vault, doing everything an owner can with money: deposit, take cash out, buy
/// and sell a stock, take the stock out in kind, sweep; and what anyone can: send a token in from outside,
/// ask the factory to recount. The handler keeps, per vault, the cash deposited less the cash withdrawn
/// since the vault was last empty, as a signed number, with no floor.
contract CapsHandler is Test {
    uint256 internal constant USD = 1e6;

    VaultFactory internal factory;
    BackdoorToken internal cash;
    BackdoorToken internal stock;
    MockRouter internal router;
    uint256 internal unit;
    BasketVault[3] public vaults;

    /// Cash in by deposit less cash out by withdrawal since the vault was last swept empty.
    int256[3] public inside;
    uint256 public deposits;
    uint256 public refusedDeposits;
    uint256 public sweeps;

    constructor(
        VaultFactory factory_,
        BackdoorToken cash_,
        BackdoorToken stock_,
        MockRouter router_,
        uint256 unit_,
        BasketVault[3] memory vaults_
    ) {
        factory = factory_;
        cash = cash_;
        stock = stock_;
        router = router_;
        unit = unit_;
        vaults = vaults_;
    }

    function _pick(uint256 seed) internal view returns (uint256 i, BasketVault vault, address owner) {
        i = seed % 3;
        vault = vaults[i];
        owner = vault.owner();
    }

    function deposit(uint256 seed, uint256 amount) external {
        (uint256 i, BasketVault vault, address owner) = _pick(seed);
        amount = bound(amount, 0, 15_000 * USD);
        cash.mint(owner, amount);
        vm.startPrank(owner);
        cash.approve(address(vault), amount);
        try vault.deposit(amount) {
            inside[i] += int256(amount);
            ++deposits;
        } catch {
            ++refusedDeposits;
        }
        vm.stopPrank();
    }

    function withdrawCash(uint256 seed, uint256 amount) external {
        (uint256 i, BasketVault vault, address owner) = _pick(seed);
        amount = bound(amount, 0, cash.balanceOf(address(vault)));
        vm.prank(owner);
        vault.withdraw(address(cash), amount);
        inside[i] -= int256(amount);
    }

    /// Cash for stock at $100, or back, at a price a little off either way.
    function trade(uint256 seed, uint256 amount, bool buying, uint256 skew) external {
        (, BasketVault vault, address owner) = _pick(seed);
        skew = bound(skew, 90, 110);
        Swap[] memory list = new Swap[](1);
        if (buying) {
            amount = bound(amount, 0, cash.balanceOf(address(vault)));
            uint256 out = amount * unit / (100 * USD) * skew / 100;
            list[0] = Swap(
                address(router),
                address(cash),
                address(stock),
                amount,
                out,
                abi.encodeCall(MockRouter.swap, (address(cash), address(stock), amount, out))
            );
        } else {
            amount = bound(amount, 0, stock.balanceOf(address(vault)));
            uint256 out = amount * 100 * USD / unit * skew / 100;
            list[0] = Swap(
                address(router),
                address(stock),
                address(cash),
                amount,
                out,
                abi.encodeCall(MockRouter.swap, (address(stock), address(cash), amount, out))
            );
        }
        vm.prank(owner);
        vault.ownerSwap(list, type(uint64).max);
    }

    function withdrawInKind(uint256 seed, uint256 amount) external {
        (, BasketVault vault, address owner) = _pick(seed);
        amount = bound(amount, 0, stock.balanceOf(address(vault)));
        vm.prank(owner);
        vault.withdraw(address(stock), amount);
    }

    function sweep(uint256 seed) external {
        (uint256 i, BasketVault vault, address owner) = _pick(seed);
        vm.prank(owner);
        address[] memory skipped = vault.withdrawAll();
        assertEq(skipped.length, 0);
        inside[i] = 0;
        ++sweeps;
    }

    /// Anyone sends a token straight to a vault: not a deposit.
    function sendFromOutside(uint256 seed, uint256 amount, bool stockToken) external {
        (, BasketVault vault,) = _pick(seed);
        if (stockToken) stock.mint(address(vault), bound(amount, 0, 50 * unit));
        else cash.mint(address(vault), bound(amount, 0, 5000 * USD));
    }

    function sync(uint256 seed) external {
        address[] memory list = new address[](1);
        list[0] = address(vaults[seed % 3]);
        factory.syncDeposits(list);
    }
}

contract DepositCapsInvariantTest is SwapFixture {
    uint256 internal constant VAULT_CAP = 10_000 * USD;
    uint256 internal constant TOTAL_CAP = 25_000 * USD;

    CapsHandler internal handler;
    BasketVault[3] internal vaults;

    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function setUp() public {
        _deploySwapPlatform();
        vaults[0] = vault;
        vaults[1] = _createVault(makeAddr("second"), keccak256("plan-2"));
        vaults[2] = _createVault(makeAddr("third"), keccak256("plan-3"));
        vm.prank(admin);
        factory.setDepositCaps(VAULT_CAP, TOTAL_CAP);
        handler = new CapsHandler(factory, cash, stockA, direct, unit, vaults);
        targetContract(address(handler));
    }

    /// The total is always the sum of what the factory counts for each vault.
    function invariant_caps_theTotalIsTheSumOfTheVaultsCounts() public view {
        uint256 sum;
        for (uint256 i; i < 3; ++i) {
            sum += factory.depositedOf(address(vaults[i]));
        }
        assertEq(factory.totalDeposited(), sum);
    }

    /// Neither cap is ever passed, in the factory's count or in a vault's own.
    function invariant_caps_neitherCapIsEverPassed() public view {
        assertLe(factory.totalDeposited(), TOTAL_CAP);
        for (uint256 i; i < 3; ++i) {
            assertLe(vaults[i].netDeposited(), VAULT_CAP);
            assertLe(factory.depositedOf(address(vaults[i])), VAULT_CAP);
        }
    }

    /// The factory's count of a vault is never under the vault's own: between deposits it can only be
    /// stale on the high side, which refuses, never on the low side, which would let money past the total.
    function invariant_caps_theFactorysCountIsNeverUnderTheVaultsOwn() public view {
        uint256 own;
        for (uint256 i; i < 3; ++i) {
            assertGe(factory.depositedOf(address(vaults[i])), vaults[i].netDeposited());
            own += vaults[i].netDeposited();
        }
        assertGe(factory.totalDeposited(), own);
    }

    /// What the cap means in money: since a vault was last empty, the cash it took in by deposit less the
    /// cash it paid out is never above its count, so never above the cap. No order of deposits, swaps,
    /// withdrawals in kind and sweeps gets more deposited cash into a vault than that.
    function invariant_caps_depositedCashLessWithdrawnCashNeverPassesTheCount() public view {
        for (uint256 i; i < 3; ++i) {
            int256 inside = handler.inside(i);
            assertLe(inside, int256(vaults[i].netDeposited()));
            assertLe(inside, int256(VAULT_CAP));
        }
    }
}
