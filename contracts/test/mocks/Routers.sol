// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

// Test routers and a test Permit2. None of them is production code.

interface IPullable {
    function transfer(address to, uint256 amount) external;
    function transferFrom(address from, address to, uint256 amount) external;
}

interface ISeizable {
    function seize(address from, address to, uint256 amount) external;
}

/// The allowance half of Permit2, as the real one behaves: an allowance has an amount and an expiry, an
/// expiry of 0 means the end of this block, and a transfer uses the allowance up unless it is the maximum.
/// The fixture puts this code at Permit2's address when the chain has none there.
contract MockPermit2 {
    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address user => mapping(address token => mapping(address spender => PackedAllowance))) public allowance;

    error AllowanceExpired(uint256 deadline);
    error InsufficientAllowance(uint256 amount);
    error TransferFailed();

    function approve(address token, address spender, uint160 amount, uint48 expiration) external virtual {
        PackedAllowance storage allowed = allowance[msg.sender][token][spender];
        allowed.amount = amount;
        allowed.expiration = expiration == 0 ? uint48(block.timestamp) : expiration;
    }

    function transferFrom(address from, address to, uint160 amount, address token) external virtual {
        PackedAllowance storage allowed = allowance[from][token][msg.sender];
        require(block.timestamp <= allowed.expiration, AllowanceExpired(allowed.expiration));
        uint256 most = allowed.amount;
        if (most != type(uint160).max) {
            require(amount <= most, InsufficientAllowance(most));
            allowed.amount = uint160(most - amount);
        }
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IPullable.transferFrom, (from, to, amount)));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), TransferFailed());
    }
}

/// A Permit2 that does not take an allowance back: `approve` with a zero amount changes nothing.
contract StickyPermit2 is MockPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external override {
        if (amount == 0) return;
        PackedAllowance storage allowed = allowance[msg.sender][token][spender];
        allowed.amount = amount;
        allowed.expiration = expiration == 0 ? uint48(block.timestamp) : expiration;
    }
}

/// A Permit2 that keeps no count: it moves whatever it is asked to, as far as the token lets it. Against it
/// the only limit left is the allowance the vault gave Permit2 on the token itself.
contract GreedyPermit2 is MockPermit2 {
    function transferFrom(address from, address to, uint160 amount, address token) external override {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IPullable.transferFrom, (from, to, amount)));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), TransferFailed());
    }
}

/// A router with its own reserve and whatever price the call names. `swap` is the honest trade: it pulls the
/// input from the caller, the way it was built to pull (directly or through Permit2), and pays the output
/// to the caller. The other functions are the ways a router can cheat.
///
/// It can also be a vault's owner (`act`), which is the only way a call from a router gets past the owner
/// check and reaches the reentrancy guard.
contract MockRouter {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bool public immutable viaPermit2;

    error PullFailed();
    error PayFailed();

    constructor(bool viaPermit2_) {
        viaPermit2 = viaPermit2_;
    }

    /// Pulls `amountIn` of `tokenIn` from the caller and pays it `amountOut` of `tokenOut`.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) external {
        _pull(tokenIn, amountIn);
        _pay(tokenOut, msg.sender, amountOut);
    }

    /// A1: the output goes somewhere else.
    function swapTo(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, address to) external {
        _pull(tokenIn, amountIn);
        _pay(tokenOut, to, amountOut);
    }

    /// An honest-looking trade that also takes `amount` of `seized` out of the caller through that token's
    /// back door: more of the input than was approved, or a token that was not part of the trade.
    function swapAndSeize(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address seized,
        uint256 amount
    ) external {
        _pull(tokenIn, amountIn);
        _pay(tokenOut, msg.sender, amountOut);
        ISeizable(seized).seize(msg.sender, address(this), amount);
    }

    /// A17: calls `target` in the middle of the trade, as a hooked pool would, and fails if that call does.
    function swapAndCall(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address target,
        bytes calldata data
    ) external {
        _pull(tokenIn, amountIn);
        _call(target, data);
        _pay(tokenOut, msg.sender, amountOut);
    }

    /// Calls `target` as this contract, bubbling a revert.
    function act(address target, bytes calldata data) external returns (bytes memory) {
        return _call(target, data);
    }

    function _pull(address token, uint256 amount) internal {
        bool ok;
        bytes memory ret;
        if (viaPermit2) {
            (ok, ret) = PERMIT2.call(
                abi.encodeCall(MockPermit2.transferFrom, (msg.sender, address(this), uint160(amount), token))
            );
            require(ok, PullFailed());
        } else {
            (ok, ret) = token.call(abi.encodeCall(IPullable.transferFrom, (msg.sender, address(this), amount)));
            require(ok && (ret.length == 0 || abi.decode(ret, (bool))), PullFailed());
        }
    }

    function _pay(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IPullable.transfer, (to, amount)));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), PayFailed());
    }

    function _call(address target, bytes memory data) internal returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}

/// Looks at an allowance inside Permit2 when it is called, and keeps what it saw. A router calls it in the
/// middle of a swap, which is the only moment the vault's allowance there can be seen.
contract Permit2Witness {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    uint160 public amount;
    uint48 public expiration;

    function look(address user, address token, address spender) external {
        (amount, expiration,) = MockPermit2(PERMIT2).allowance(user, token, spender);
    }
}
