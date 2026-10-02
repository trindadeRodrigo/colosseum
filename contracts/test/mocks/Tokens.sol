// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

// Test tokens. Each variant breaks ERC-20 in one way a real token does. None of them is production code.

/// Shared bookkeeping. `_move` and `_spend` report failure instead of reverting, so each variant decides
/// what a failure looks like from outside.
abstract contract TokenBase {
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) internal _balances;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function balanceOf(address account) public view virtual returns (uint256) {
        return _balances[account];
    }

    function _approve(address owner, address spender, uint256 amount) internal {
        allowance[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }

    function _move(address from, address to, uint256 amount) internal returns (bool) {
        if (_balances[from] < amount) return false;
        _balances[from] -= amount;
        _balances[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function _spend(address owner, address spender, uint256 amount) internal returns (bool) {
        uint256 allowed = allowance[owner][spender];
        if (allowed < amount) return false;
        if (allowed != type(uint256).max) allowance[owner][spender] = allowed - amount;
        return true;
    }
}

/// A well-behaved token: reverts on failure and returns true.
contract MockToken is TokenBase {
    constructor(uint8 decimals_) TokenBase(decimals_) {}

    function approve(address spender, uint256 amount) external returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        require(_move(msg.sender, to, amount), InsufficientBalance());
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        require(_spend(from, msg.sender, amount), InsufficientAllowance());
        require(_move(from, to, amount), InsufficientBalance());
        return true;
    }
}

/// Returns `false` instead of reverting. `setFrozen(true)` makes every transfer return `false`.
contract FalseReturnToken is TokenBase {
    bool public frozen;

    constructor(uint8 decimals_) TokenBase(decimals_) {}

    function setFrozen(bool on) external {
        frozen = on;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (frozen) return false;
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (frozen || _balances[from] < amount) return false;
        if (!_spend(from, msg.sender, amount)) return false;
        return _move(from, to, amount);
    }
}

/// USDT-style: `transfer`, `transferFrom` and `approve` return nothing.
contract NoReturnToken is TokenBase {
    constructor(uint8 decimals_) TokenBase(decimals_) {}

    function approve(address spender, uint256 amount) external {
        _approve(msg.sender, spender, amount);
    }

    function transfer(address to, uint256 amount) external {
        require(_move(msg.sender, to, amount), InsufficientBalance());
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(_spend(from, msg.sender, amount), InsufficientAllowance());
        require(_move(from, to, amount), InsufficientBalance());
    }
}

/// Skims `feeBps` of every transfer: the receiver gets less than was sent. The fee is burned.
contract FeeToken is TokenBase {
    uint16 public feeBps;

    constructor(uint8 decimals_, uint16 feeBps_) TokenBase(decimals_) {
        feeBps = feeBps_;
    }

    function setFeeBps(uint16 feeBps_) external {
        feeBps = feeBps_;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _moveWithFee(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(_spend(from, msg.sender, amount), InsufficientAllowance());
        _moveWithFee(from, to, amount);
        return true;
    }

    function _moveWithFee(address from, address to, uint256 amount) internal {
        uint256 fee = amount * feeBps / 10_000;
        require(_move(from, to, amount), InsufficientBalance());
        _balances[to] -= fee;
        totalSupply -= fee;
        emit Transfer(to, address(0), fee);
    }
}

/// An issuer freeze: transfers revert while frozen. `setBricked(true)` makes `balanceOf` revert too, as a
/// fully paused token proxy would.
contract FreezableToken is MockToken {
    bool public frozen;
    bool public bricked;

    error Frozen();

    constructor(uint8 decimals_) MockToken(decimals_) {}

    function setFrozen(bool on) external {
        frozen = on;
    }

    function setBricked(bool on) external {
        bricked = on;
    }

    function balanceOf(address account) public view override returns (uint256) {
        require(!bricked, Frozen());
        return _balances[account];
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(!frozen, Frozen());
        require(_move(msg.sender, to, amount), InsufficientBalance());
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        require(!frozen, Frozen());
        require(_spend(from, msg.sender, amount), InsufficientAllowance());
        require(_move(from, to, amount), InsufficientBalance());
        return true;
    }
}

/// A token that calls out in the middle of a transfer, as a token with hooks would (ERC-777's
/// `tokensToSend`). It can also act as a vault's owner (`act`), which is the only way a re-entering call gets
/// past the owner check.
contract HookToken is TokenBase {
    address public hookTarget;
    bytes public hookData;

    constructor(uint8 decimals_) TokenBase(decimals_) {}

    function setHook(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
    }

    /// Calls `target` as this contract, bubbling a revert.
    function act(address target, bytes calldata data) external returns (bytes memory) {
        return _call(target, data);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (hookTarget != address(0)) _call(hookTarget, hookData);
        require(_move(msg.sender, to, amount), InsufficientBalance());
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (hookTarget != address(0)) _call(hookTarget, hookData);
        require(_spend(from, msg.sender, amount), InsufficientAllowance());
        require(_move(from, to, amount), InsufficientBalance());
        return true;
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

/// The shape of a tokenised stock: a pause flag, a per-account freeze list and a multiplier, all read on
/// every transfer. It makes a transfer cost about what a real one costs.
contract StockLikeToken is MockToken {
    bool public paused;
    uint256 public multiplier = 1e18;
    mapping(address => bool) public frozen;

    error Blocked();

    constructor(uint8 decimals_) MockToken(decimals_) {}

    function setFrozen(address who, bool on) external {
        frozen[who] = on;
    }

    function _checks(address from, address to) internal view {
        require(!paused && !frozen[from] && !frozen[to] && multiplier != 0, Blocked());
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _checks(msg.sender, to);
        require(_move(msg.sender, to, amount), InsufficientBalance());
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        _checks(from, to);
        require(_spend(from, msg.sender, amount), InsufficientAllowance());
        require(_move(from, to, amount), InsufficientBalance());
        return true;
    }
}

/// A token whose code later burns gas (a bad upgrade, or malice) in its balance read, its transfer, or both:
/// a set amount, or with `type(uint256).max` every unit it is given.
contract GasBurnToken is MockToken {
    uint256 public balanceBurn;
    uint256 public transferBurn;

    constructor(uint8 decimals_) MockToken(decimals_) {}

    function setBurn(uint256 onBalance, uint256 onTransfer) external {
        balanceBurn = onBalance;
        transferBurn = onTransfer;
    }

    function balanceOf(address account) public view override returns (uint256) {
        _burn(balanceBurn);
        return _balances[account];
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _burn(transferBurn);
        require(_move(msg.sender, to, amount), InsufficientBalance());
        return true;
    }

    function _burn(uint256 amount) internal view {
        if (amount == type(uint256).max) {
            assembly {
                invalid()
            }
        }
        uint256 start = gasleft();
        while (start - gasleft() < amount) {}
    }
}

/// Once armed with `setBomb(size)`, answers every balance read and every transfer with `size` bytes of
/// return data, starting with the right word. A megabyte costs the token itself about 2.2 million gas.
contract BombToken is MockToken {
    uint256 public size;

    constructor(uint8 decimals_) MockToken(decimals_) {}

    function setBomb(uint256 size_) external {
        size = size_;
    }

    function balanceOf(address account) public view override returns (uint256) {
        uint256 b = _balances[account];
        uint256 n = size;
        if (n != 0) {
            assembly {
                mstore(0, b)
                return(0, n)
            }
        }
        return b;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        require(_move(msg.sender, to, amount), InsufficientBalance());
        uint256 n = size;
        if (n != 0) {
            assembly {
                mstore(0, 1)
                return(0, n)
            }
        }
        return true;
    }
}

/// A token whose balance read answers with fewer than 32 bytes: `answerBytes` of them, 0 for nothing at all.
contract ShortAnswerToken is MockToken {
    bool public short;
    uint256 public answerBytes;

    constructor(uint8 decimals_) MockToken(decimals_) {}

    function setShort(bool on, uint256 answerBytes_) external {
        short = on;
        answerBytes = answerBytes_;
    }

    function balanceOf(address account) public view override returns (uint256) {
        uint256 b = _balances[account];
        if (short) {
            uint256 n = answerBytes;
            assembly {
                mstore(0, b)
                return(0, n)
            }
        }
        return b;
    }
}
