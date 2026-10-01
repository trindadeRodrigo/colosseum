// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BasketVault, IERC20, IAggregatorV3} from "./BasketVault.sol";
import {SlipstreamAdapter} from "./SlipstreamAdapter.sol";

/// Not deployed. Its runtime bytecode is injected with an eth_call state override on Base mainnet
/// (see script/base-sim.sh), together with a USDC balance for the same address. One eth_call then
/// runs: deploy vault -> deposit USDC -> keeper swap USDC->NVDAc on Aerodrome -> in-kind withdraw.
/// This is the stand-in for a fork test, because anvil cannot execute B20 precompile tokens.
contract BaseSim {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address constant NVDA_FEED = 0x04689a41629776563E6822F76f2e57D148d28513;
    address constant USDC_FEED = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;
    address constant AERO_POOL = 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;

    struct Result {
        address vault;
        uint256 feedPrice8;
        uint256 feedAgeSec;
        uint256 spentUsdc;
        uint256 receivedNvdac;
        uint256 execPrice8;
        uint256 valueBefore8;
        uint256 valueAfter8;
        uint256 gasDeployVault;
        uint256 gasKeeperSwap;
        uint256 gasWithdrawAll;
        uint256 vaultNvdacAfterSwap;
        uint256 recipientNvdacAfterWithdraw;
        uint256 recipientUsdcAfterWithdraw;
    }

    function run(uint256 amountIn, address withdrawTo) external returns (Result memory r) {
        SlipstreamAdapter adapter = new SlipstreamAdapter();
        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = NVDAC;
        address[] memory feeds = new address[](2);
        feeds[0] = USDC_FEED;
        feeds[1] = NVDA_FEED;
        address[] memory routers = new address[](1);
        routers[0] = address(adapter);
        BasketVault.Pull[] memory pulls = new BasketVault.Pull[](1);
        pulls[0] = BasketVault.Pull.Direct;

        uint256 g = gasleft();
        BasketVault vault = new BasketVault(address(this), address(this), tokens, feeds, routers, pulls, 125, 26 hours);
        r.gasDeployVault = g - gasleft();
        r.vault = address(vault);

        IERC20(USDC).approve(address(vault), amountIn);
        vault.deposit(USDC, amountIn);

        (, int256 px,, uint256 updatedAt,) = IAggregatorV3(NVDA_FEED).latestRoundData();
        r.feedPrice8 = uint256(px);
        r.feedAgeSec = block.timestamp - updatedAt;
        // USDC 6dp -> NVDAc 8dp at an 8dp price, 1% under the feed
        uint256 minOut = amountIn * 1e10 / uint256(px) * 99 / 100;

        r.valueBefore8 = vault.valueUsd8();
        bytes memory data = abi.encodeCall(SlipstreamAdapter.swapExactIn, (AERO_POOL, USDC, amountIn, address(vault)));
        g = gasleft();
        (r.spentUsdc, r.receivedNvdac) = vault.keeperSwap(address(adapter), USDC, NVDAC, amountIn, minOut, data);
        r.gasKeeperSwap = g - gasleft();
        r.valueAfter8 = vault.valueUsd8();
        r.execPrice8 = r.spentUsdc * 1e10 / r.receivedNvdac;
        r.vaultNvdacAfterSwap = IERC20(NVDAC).balanceOf(address(vault));

        g = gasleft();
        vault.withdrawAll(withdrawTo);
        r.gasWithdrawAll = g - gasleft();
        r.recipientNvdacAfterWithdraw = IERC20(NVDAC).balanceOf(withdrawTo);
        r.recipientUsdcAfterWithdraw = IERC20(USDC).balanceOf(withdrawTo);
    }
}
