// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {TestnetKit} from "../../script/testnet/TestnetKit.s.sol";
import {BasketVault} from "../../src/BasketVault.sol";
import {PERMIT2} from "../../src/interfaces/IVaultConfig.sol";
import {AssetConfig, Params, Swap, Weight} from "../../src/interfaces/Types.sol";
import {PoolKey, TestMarket} from "../../testnet/TestMarket.sol";
import {TestPriceFeed} from "../../testnet/TestPriceFeed.sol";
import {TestToken} from "../../testnet/TestToken.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {UniV4Calldata} from "../fork/UniV4Calldata.sol";
import {MockPermit2} from "../mocks/Routers.sol";

/// The Robinhood Chain test network as the kit (TNET-2) leaves it, with the vault on it: `TestnetKit.s.sol` run
/// on the file for chain 46630 with a price writer of the test's, then the vault's own deploy script with the
/// kit's tokens, price contracts and router, and test cash for a person. `_chain` puts in place what the chain
/// under the test lacks of chain 46630: `_localChain` the real PoolManager's code (read from chain 46630,
/// `test/fixtures/v4-pool-manager.json`) at its own address, the CREATE2 deployer and the mock Permit2.
abstract contract KitFixture is Test {
    using stdJson for string;

    /// Monday 2026-10-05, 19:56:40 UTC: after every round the file holds, before the session closes.
    uint256 internal constant KIT_TIME = 1_791_230_200;
    /// Tuesday 2026-10-06, 15:00 UTC: in session.
    uint256 internal constant TUESDAY_1500 = 1_791_298_800;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint256 internal constant Q96 = 2 ** 96;

    address internal writer = makeAddr("priceWriter");
    address internal keeper = makeAddr("keeper");
    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");

    TestnetKit internal kit;
    TestnetKit.Config internal cfg;
    TestnetKit.Deployed internal d;
    TestMarket internal market;
    TestToken internal cash;
    Deploy internal vaultDeploy;
    VaultFactory internal factory;

    /// The chain the world runs on: what it lacks of chain 46630 is put in place here.
    function _chain() internal virtual returns (bool ready);

    /// The CREATE2 deployer's code (Arachnid's deterministic deployment proxy).
    bytes internal constant CREATE2_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    /// The test chain, with the real pool code.
    function _localChain() internal returns (bool) {
        string memory fixture = vm.readFile("test/fixtures/v4-pool-manager.json");
        vm.etch(fixture.readAddress(".address"), fixture.readBytes(".runtime"));
        if (CREATE2_DEPLOYER.code.length == 0) vm.etch(CREATE2_DEPLOYER, CREATE2_CODE);
        if (PERMIT2.code.length == 0) vm.etch(PERMIT2, address(new MockPermit2()).code);
        return true;
    }

    function setUp() public virtual {
        if (!_chain()) return;
        vm.chainId(46_630);
        vm.warp(KIT_TIME);
        kit = new TestnetKit();
        cfg = kit.readConfig("script/testnet/config/46630.json");
        cfg.priceWriter = writer;
        d = kit.deploy(cfg, address(kit));
        market = TestMarket(d.market);
        cash = TestToken(d.cash);

        // The vault's platform, as `Deploy.s.sol` writes it from a config the kit's record fills.
        vaultDeploy = new Deploy();
        Deploy.Config memory v;
        v.chainId = 46_630;
        v.adminIsDeployer = true;
        v.keeper = keeper;
        v.publishDelay = 300;
        v.params = Params(125, 100, 50, 3600, 52_200, 72_000);
        v.priceDevBps = 200;
        v.cashToken = d.cash;
        v.assets = new Deploy.Asset[](d.tokens.length + 1);
        v.assets[0] = Deploy.Asset(d.cash, _cashAsset());
        for (uint256 i; i < d.tokens.length; ++i) {
            uint256 p = uint256(cfg.tokens[i].answer);
            v.assets[i + 1] = Deploy.Asset(
                d.tokens[i].token,
                kit.vaultAsset(
                    d.tokens[i].feed,
                    d.tokens[i].average,
                    d.tokens[i].token,
                    uint128(p * 775 / 1000),
                    uint128(p * 5 / 4)
                )
            );
        }
        v.routers = new Deploy.Router[](1);
        v.routers[0] = Deploy.Router(d.router, 2);
        factory = VaultFactory(vaultDeploy.deploy(v, address(vaultDeploy)).factory);

        // Test cash for the person, from the admin's own mint.
        vm.startPrank(address(kit));
        cash.grantRole(cash.MINTER_ROLE(), address(this));
        vm.stopPrank();
        cash.mint(owner, 100_000e6);
    }

    function _cashAsset() internal pure returns (AssetConfig memory a) {
        a.tokenDecimals = 6;
    }

    modifier ready() {
        if (address(kit) == address(0)) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _index(string memory symbol) internal view returns (uint256) {
        for (uint256 i; i < cfg.tokens.length; ++i) {
            if (keccak256(bytes(cfg.tokens[i].symbol)) == keccak256(bytes(symbol))) return i;
        }
        revert("no such token");
    }

    function _key(address token) internal view returns (UniV4Calldata.PoolKey memory) {
        PoolKey memory k = market.poolKey(token);
        return UniV4Calldata.PoolKey(k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks);
    }

    /// The token's price the pool holds, in the feed's 8 decimals.
    function _poolPrice(address token) internal view returns (uint256) {
        uint256 sqrtP = market.poolSqrtPrice(token);
        // currency1 per currency0 in raw units, times 2^96. A token has 18 decimals and the cash 6, so a
        // dollar price in 8 decimals is that ratio times 10^20 one way, and its inverse the other.
        uint256 ratio = Math.mulDiv(sqrtP, sqrtP, Q96);
        return token < address(cash) ? Math.mulDiv(ratio, 1e20, Q96) : Math.mulDiv(Q96, 1e20, ratio);
    }

    function _feedPrice(uint256 i) internal view returns (uint256) {
        (, int256 answer,,,) = TestPriceFeed(d.tokens[i].feed).latestRoundData();
        return uint256(answer);
    }

    function _apartBps(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a > b ? a - b : b - a) * 10_000 / b;
    }

    /// A swap of `amountIn` cash for `token` through the router, at least `minOut` back.
    function _buy(address token, uint256 amountIn, uint256 minOut) internal view returns (Swap memory) {
        return Swap({
            router: d.router,
            tokenIn: address(cash),
            tokenOut: token,
            amountIn: amountIn,
            minOut: minOut,
            data: UniV4Calldata.exactInSingle(_key(token), address(cash), amountIn, minOut, address(0), type(uint64).max)
        });
    }

    /// How much of token `i` `cashAmount` buys at its feed, less `lossBps`.
    function _atFeed(uint256 i, uint256 cashAmount, uint256 lossBps) internal view returns (uint256) {
        return cashAmount * 1e8 * 1e18 / (_feedPrice(i) * 1e6) * (10_000 - lossBps) / 10_000;
    }

    /// The copier's round: every price and average of the given tokens written at `price`, stamped now.
    function _copy(uint256 i, uint256 price) internal {
        vm.startPrank(writer);
        TestPriceFeed(d.tokens[i].feed).write(int256(price), block.timestamp);
        TestPriceFeed(d.tokens[i].average).write(int256(price), block.timestamp);
        vm.stopPrank();
    }

    function _vault(Weight[] memory targets) internal returns (BasketVault vault) {
        vm.startPrank(owner);
        vault = BasketVault(factory.createVault(keccak256("plan-1"), targets, bytes32(0), 0, false));
        cash.approve(address(vault), 10_000e6);
        vault.deposit(10_000e6);
        vm.stopPrank();
    }
}
