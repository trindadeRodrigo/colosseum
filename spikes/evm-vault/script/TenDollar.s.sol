// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BasketVault, IERC20, IAggregatorV3} from "../src/BasketVault.sol";
import {UniV4Calldata} from "../src/UniV4Calldata.sol";
import {SlipstreamAdapter} from "../src/SlipstreamAdapter.sol";

/// Real-money smoke test, about $10: deploy a vault, deposit cash, keeper-swap cash -> NVDA,
/// withdraw everything in kind to the sender. The sender is owner and keeper.
///
/// Robinhood Chain (works; broadcast on an anvil fork, never on mainnet):
///   forge script script/TenDollar.s.sol --rpc-url $RH_RPC_URL --account <keystore> --sender <addr>            # dry run
///   forge script script/TenDollar.s.sol --rpc-url $RH_RPC_URL --account <keystore> --sender <addr> --broadcast --slow
///
/// Base: forge script CANNOT run this, because its local EVM cannot execute B20 precompile tokens
/// (OpcodeNotFound). Use script/ten-dollar-cast.sh base instead; it sends the same five transactions with cast.
///
/// Env: AMOUNT (cash, 6dp, default 10e6), SLIPPAGE_BPS (default 100), KEEP=true to skip the withdrawal.
contract TenDollar is Script {
    struct Cfg {
        address cash;
        address stock;
        address cashFeed;
        address stockFeed;
        address router; // address(0) = deploy a SlipstreamAdapter
        address pool; // Slipstream pool when router == 0
        BasketVault.Pull pull;
    }

    function cfg() internal view returns (Cfg memory c) {
        if (block.chainid == 4663) {
            c.cash = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // USDG
            c.stock = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC; // NVDA Stock Token
            c.cashFeed = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;
            c.stockFeed = 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15;
            c.router = 0x204FAca1764B154221e35c0d20aBb3c525710498; // Universal Router 2.1.2
            c.pull = BasketVault.Pull.Permit2;
        } else if (block.chainid == 8453) {
            c.cash = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // USDC
            c.stock = 0xb20000000000000000000078ee7ce2fE4908108C; // NVDAc (B20 precompile)
            c.cashFeed = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;
            c.stockFeed = 0x04689a41629776563E6822F76f2e57D148d28513;
            c.pool = 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9; // Aerodrome Slipstream NVDAc/USDC
            c.pull = BasketVault.Pull.Direct;
        } else {
            revert("unsupported chain");
        }
    }

    function run() external {
        Cfg memory c = cfg();
        uint256 amount = vm.envOr("AMOUNT", uint256(10e6));
        uint256 slippageBps = vm.envOr("SLIPPAGE_BPS", uint256(100));
        bool keep = vm.envOr("KEEP", false);

        vm.startBroadcast();
        address me = msg.sender;
        if (c.router == address(0)) c.router = address(new SlipstreamAdapter());

        BasketVault vault;
        {
            address[] memory tokens = new address[](2);
            (tokens[0], tokens[1]) = (c.cash, c.stock);
            address[] memory feeds = new address[](2);
            (feeds[0], feeds[1]) = (c.cashFeed, c.stockFeed);
            address[] memory routers = new address[](1);
            routers[0] = c.router;
            BasketVault.Pull[] memory pulls = new BasketVault.Pull[](1);
            pulls[0] = c.pull;
            vault = new BasketVault(me, me, tokens, feeds, routers, pulls, 125, 26 hours);
        }

        IERC20(c.cash).approve(address(vault), amount);
        vault.deposit(c.cash, amount);

        (, int256 px,, uint256 updatedAt,) = IAggregatorV3(c.stockFeed).latestRoundData();
        uint256 stockDec = IERC20(c.stock).decimals();
        // cash is 6dp and treated as $1 here; the vault itself prices both sides with Chainlink
        uint256 minOut = amount * 10 ** (stockDec + 8 - 6) / uint256(px) * (10_000 - slippageBps) / 10_000;

        bytes memory data = c.pull == BasketVault.Pull.Permit2
            ? UniV4Calldata.exactInSingle(
                UniV4Calldata.PoolKey(c.cash, c.stock, 100, 1, address(0)), c.cash, amount, minOut, false, address(0), block.timestamp + 30 minutes
            )
            : abi.encodeCall(SlipstreamAdapter.swapExactIn, (c.pool, c.cash, amount, address(vault)));

        (uint256 spent, uint256 received) = vault.keeperSwap(c.router, c.cash, c.stock, amount, minOut, data);
        if (!keep) vault.withdrawAll(me);
        vm.stopBroadcast();

        console2.log("vault", address(vault));
        console2.log("feed price (8dp)", uint256(px), "age (s)", block.timestamp - updatedAt);
        console2.log("spent cash (6dp)", spent);
        console2.log("received stock (raw)", received);
        console2.log("minOut (raw)", minOut);
        console2.log("sender stock balance", IERC20(c.stock).balanceOf(me));
    }
}
