// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

// THROWAWAY SPIKE. Not the production vault: no clones, no recipe versions, no cooldown,
// no weekly loss cap, no market-hours gate, no guardian. It exists to answer one question:
// can a contract hold and trade stock tokens on Robinhood Chain and Base under the
// "balance delta + Chainlink value invariant" rule.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

contract BasketVault {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    struct Asset {
        address token;
        address feed; // Chainlink USD feed, 8 decimals on both chains
        uint8 tokenDecimals;
        uint8 feedDecimals;
    }

    enum Pull {
        None, // router not allowed
        Direct, // router pulls with token.transferFrom (Aerodrome, 0x AllowanceHolder)
        Permit2 // router pulls through Permit2 (Uniswap Universal Router)
    }

    address public immutable owner;
    address public keeper;
    uint16 public immutable maxLossBps;
    uint32 public immutable maxFeedAge;
    Asset[] public assets;
    mapping(address => uint256) internal assetIndexPlus1;
    mapping(address => Pull) public routerPull;
    uint256 private locked = 1;

    error NotOwner();
    error NotKeeper();
    error Reentered();
    error RouterNotAllowed(address router);
    error TokenNotInRecipe(address token);
    error RouterCallFailed(bytes reason);
    error SpentTooMuch(uint256 spent, uint256 amountIn);
    error OutputTooLow(uint256 received, uint256 minOut);
    error OtherAssetFell(address token);
    error ValueFell(uint256 valueBefore, uint256 valueAfter);
    error StaleFeed(address feed, uint256 updatedAt);
    error BadPrice(address feed);
    error TransferFailed(address token);

    event KeeperSwap(address indexed tokenIn, address indexed tokenOut, uint256 spent, uint256 received, uint256 valueBefore, uint256 valueAfter);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentered();
        locked = 2;
        _;
        locked = 1;
    }

    constructor(
        address owner_,
        address keeper_,
        address[] memory tokens,
        address[] memory feeds,
        address[] memory routers,
        Pull[] memory pulls,
        uint16 maxLossBps_,
        uint32 maxFeedAge_
    ) {
        owner = owner_;
        keeper = keeper_;
        maxLossBps = maxLossBps_;
        maxFeedAge = maxFeedAge_;
        for (uint256 i; i < tokens.length; ++i) {
            assets.push(Asset(tokens[i], feeds[i], IERC20(tokens[i]).decimals(), IAggregatorV3(feeds[i]).decimals()));
            assetIndexPlus1[tokens[i]] = i + 1;
        }
        for (uint256 i; i < routers.length; ++i) {
            routerPull[routers[i]] = pulls[i];
        }
    }

    // ---- owner ----

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
    }

    function deposit(address token, uint256 amount) external onlyOwner {
        _call(token, abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount)));
    }

    /// In-kind withdrawal. Calls no router and reads no price feed.
    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        _call(token, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function withdrawAll(address to) external onlyOwner nonReentrant {
        for (uint256 i; i < assets.length; ++i) {
            address t = assets[i].token;
            uint256 b = IERC20(t).balanceOf(address(this));
            if (b != 0) _call(t, abi.encodeCall(IERC20.transfer, (to, b)));
        }
    }

    // ---- keeper ----

    function keeperSwap(address router, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes calldata data)
        external
        nonReentrant
        returns (uint256 spent, uint256 received)
    {
        if (msg.sender != keeper) revert NotKeeper();
        Pull pull = routerPull[router];
        if (pull == Pull.None) revert RouterNotAllowed(router);
        if (assetIndexPlus1[tokenIn] == 0) revert TokenNotInRecipe(tokenIn);
        if (assetIndexPlus1[tokenOut] == 0 || tokenOut == tokenIn) revert TokenNotInRecipe(tokenOut);

        uint256 n = assets.length;
        uint256[] memory beforeBal = new uint256[](n);
        uint256[] memory price = new uint256[](n);
        uint256 valueBefore;
        for (uint256 i; i < n; ++i) {
            beforeBal[i] = IERC20(assets[i].token).balanceOf(address(this));
            price[i] = _price(assets[i]);
            valueBefore += _usd(assets[i], beforeBal[i], price[i]);
        }

        // exact approval, zeroed afterwards
        if (pull == Pull.Permit2) {
            _call(tokenIn, abi.encodeCall(IERC20.approve, (PERMIT2, amountIn)));
            IPermit2(PERMIT2).approve(tokenIn, router, uint160(amountIn), uint48(block.timestamp));
        } else {
            _call(tokenIn, abi.encodeCall(IERC20.approve, (router, amountIn)));
        }

        (bool ok, bytes memory ret) = router.call(data);
        if (!ok) revert RouterCallFailed(ret);

        if (pull == Pull.Permit2) {
            IPermit2(PERMIT2).approve(tokenIn, router, 0, 0);
            _call(tokenIn, abi.encodeCall(IERC20.approve, (PERMIT2, 0)));
        } else {
            _call(tokenIn, abi.encodeCall(IERC20.approve, (router, 0)));
        }

        // the vault trusts only its own balances
        uint256 valueAfter;
        for (uint256 i; i < n; ++i) {
            address t = assets[i].token;
            uint256 afterBal = IERC20(t).balanceOf(address(this));
            if (t == tokenIn) {
                spent = beforeBal[i] - afterBal; // underflow reverts if it somehow grew
                if (spent > amountIn) revert SpentTooMuch(spent, amountIn);
            } else if (t == tokenOut) {
                received = afterBal - beforeBal[i];
                if (received < minOut) revert OutputTooLow(received, minOut);
            } else if (afterBal < beforeBal[i]) {
                revert OtherAssetFell(t);
            }
            valueAfter += _usd(assets[i], afterBal, price[i]);
        }
        if (valueAfter * 10_000 < valueBefore * (10_000 - maxLossBps)) revert ValueFell(valueBefore, valueAfter);
        emit KeeperSwap(tokenIn, tokenOut, spent, received, valueBefore, valueAfter);
    }

    // ---- views ----

    /// Vault value in USD, 8 decimals, at Chainlink prices.
    function valueUsd8() external view returns (uint256 v) {
        for (uint256 i; i < assets.length; ++i) {
            v += _usd(assets[i], IERC20(assets[i].token).balanceOf(address(this)), _price(assets[i]));
        }
    }

    function assetCount() external view returns (uint256) {
        return assets.length;
    }

    // ---- internals ----

    function _price(Asset memory a) internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = IAggregatorV3(a.feed).latestRoundData();
        if (answer <= 0) revert BadPrice(a.feed);
        if (block.timestamp - updatedAt > maxFeedAge) revert StaleFeed(a.feed, updatedAt);
        return uint256(answer);
    }

    function _usd(Asset memory a, uint256 bal, uint256 price) internal pure returns (uint256) {
        // -> 8 decimals
        return bal * price * 1e8 / (10 ** (uint256(a.tokenDecimals) + a.feedDecimals));
    }

    function _call(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed(token);
    }
}
