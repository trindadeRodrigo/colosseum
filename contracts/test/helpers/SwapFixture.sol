// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Swap, Weight} from "../../src/interfaces/Types.sol";
import {MockRouter} from "../mocks/Routers.sol";
import {BackdoorToken} from "../mocks/Tokens.sol";
import {VaultFixture} from "./VaultFixture.sol";

/// The platform with something to trade: a cash token with 6 decimals as the real dollar tokens have, three
/// stock tokens at the decimals under test, and two routers with reserves, one pulling directly and one
/// through Permit2. The tokens have a back door so that a hostile router has a way to take what it was
/// never approved for.
abstract contract SwapFixture is VaultFixture {
    uint256 internal constant USD = 1e6;

    uint8 internal dec;
    /// One whole stock token.
    uint256 internal unit;

    BackdoorToken internal cash;
    BackdoorToken internal stockA;
    BackdoorToken internal stockB;
    BackdoorToken internal stockC;
    MockRouter internal direct;
    MockRouter internal viaPermit2;

    function _decimals() internal pure virtual returns (uint8);

    function _deploySwapPlatform() internal {
        _deployPlatform();
        dec = _decimals();
        unit = 10 ** dec;
        cash = new BackdoorToken(6);
        stockA = new BackdoorToken(dec);
        stockB = new BackdoorToken(dec);
        stockC = new BackdoorToken(dec);
        _list(address(cash), 6);
        _list(address(stockA), dec);
        _list(address(stockB), dec);
        _list(address(stockC), dec);
        _setCash(address(cash));

        direct = new MockRouter(false);
        viaPermit2 = new MockRouter(true);
        vm.startPrank(admin);
        factory.setRouter(address(direct), 1);
        factory.setRouter(address(viaPermit2), 2);
        vm.stopPrank();
        MockRouter[2] memory routers = [direct, viaPermit2];
        for (uint256 i; i < routers.length; ++i) {
            cash.mint(address(routers[i]), 1e9 * USD);
            stockA.mint(address(routers[i]), 1e9 * unit);
            stockB.mint(address(routers[i]), 1e9 * unit);
            stockC.mint(address(routers[i]), 1e9 * unit);
        }

        cash.mint(owner, 1_000_000 * USD);
        vm.prank(owner);
        cash.approve(address(vault), type(uint256).max);
    }

    /// An honest swap through `router`: exactly `amountIn` in, exactly `amountOut` out, and no less accepted.
    function _swap(MockRouter router, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)
        internal
        pure
        returns (Swap memory)
    {
        return Swap({
            router: address(router),
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minOut: amountOut,
            data: abi.encodeCall(MockRouter.swap, (tokenIn, tokenOut, amountIn, amountOut))
        });
    }

    /// Two targets, put in ascending order of token as the vault and the registry want them.
    function _targets(address a, uint16 aBps, address b, uint16 bBps) internal pure returns (Weight[] memory list) {
        list = new Weight[](2);
        (list[0], list[1]) = a < b ? (Weight(a, aBps), Weight(b, bBps)) : (Weight(b, bBps), Weight(a, aBps));
    }

    /// A shared portfolio of the three stocks, 50%, 30% and 20%, sorted by token.
    function _threeStocks() internal view returns (Weight[] memory list) {
        list = new Weight[](3);
        list[0] = Weight(address(stockA), 5000);
        list[1] = Weight(address(stockB), 3000);
        list[2] = Weight(address(stockC), 2000);
        return _sort(list);
    }

    function _sort(Weight[] memory list) internal pure returns (Weight[] memory) {
        for (uint256 i = 1; i < list.length; ++i) {
            Weight memory w = list[i];
            uint256 j = i;
            for (; j > 0 && list[j - 1].token > w.token; --j) {
                list[j] = list[j - 1];
            }
            list[j] = w;
        }
        return list;
    }

    function _assertNoAllowance(address vault_, address token, address router) internal view {
        assertEq(BackdoorToken(token).allowance(vault_, router), 0, "allowance to the router");
        assertEq(BackdoorToken(token).allowance(vault_, PERMIT2_ADDRESS), 0, "allowance to Permit2");
        (bool ok, bytes memory ret) = PERMIT2_ADDRESS.staticcall(
            abi.encodeWithSignature("allowance(address,address,address)", vault_, token, router)
        );
        assertTrue(ok);
        (uint160 amount,,) = abi.decode(ret, (uint160, uint48, uint48));
        assertEq(amount, 0, "allowance inside Permit2");
    }
}
