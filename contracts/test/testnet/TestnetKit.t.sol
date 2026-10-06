// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TestnetKit} from "../../script/testnet/TestnetKit.s.sol";
import {BasketVault} from "../../src/BasketVault.sol";
import {IBasketVault} from "../../src/interfaces/IBasketVault.sol";
import {PERMIT2} from "../../src/interfaces/IVaultConfig.sol";
import {Swap, Weight} from "../../src/interfaces/Types.sol";
import {PoolKey, TestMarket} from "../../testnet/TestMarket.sol";
import {TestPriceFeed} from "../../testnet/TestPriceFeed.sol";
import {TestStockToken} from "../../testnet/TestStockToken.sol";
import {KitFixture} from "../helpers/KitFixture.sol";

/// The Robinhood Chain test network kit (TNET-2) run end to end: the kit, then the vault's platform on it
/// (`KitFixture`), then a person's vault that buys through Universal Router 2.1.2 and a keeper that
/// rebalances it, then the market following a copied price.
///
/// `TestnetKitTest` runs on the test chain with the real pool code and Universal Router built from its 2.1.2
/// source (`script/testnet/UniversalRouter-2.1.2.json`), and the mock Permit2 of the unit tests.
/// `TestnetKitForkTest` runs the same on a fork of the live test network, with its own PoolManager, Permit2
/// and CREATE2 deployer, when `RH_TESTNET_FORK_URL` is set; it sends nothing to any network.
abstract contract TestnetKitWorld is KitFixture {
    // ---- the kit

    /// Every contract of the file is there, set up as the file says, and a second run sends nothing.
    function test_kit_deploysEverything_andASecondRunSendsNothing() public ready {
        uint256 first = kit.sent();
        assertGt(first, 0);
        assertGt(d.router.code.length, 24_000, "Universal Router 2.1.2");
        assertEq(market.operator(), writer);
        assertEq(address(market.poolManager()), cfg.poolManager);
        assertEq(market.cash(), d.cash);
        assertEq(cash.decimals(), 6);
        assertTrue(cash.hasRole(cash.MINTER_ROLE(), d.market));
        for (uint256 i; i < d.tokens.length; ++i) {
            TestStockToken token = TestStockToken(d.tokens[i].token);
            assertEq(token.symbol(), cfg.tokens[i].symbol);
            assertEq(token.decimals(), 18);
            assertTrue(token.hasRole(token.MINTER_ROLE(), d.market));
            assertTrue(token.hasRole(token.ISSUER_ROLE(), address(kit)));
            assertEq(TestPriceFeed(d.tokens[i].feed).writer(), writer);
            assertEq(TestPriceFeed(d.tokens[i].average).writer(), writer);
            assertEq(_feedPrice(i), uint256(cfg.tokens[i].answer));
            assertEq(market.feedOf(address(token)), d.tokens[i].feed);
            assertEq(market.poolSqrtPrice(address(token)), market.testSqrtPrice(address(token)));
            assertGt(market.poolLiquidity(address(token)), 0);
            assertEq(d.tokens[i].poolId, market.poolId(address(token)));
        }

        TestnetKit.Deployed memory again = kit.deploy(cfg, address(kit));
        assertEq(kit.sent(), first, "a second run sends nothing");
        assertEq(again.router, d.router);
        assertEq(again.market, d.market);
        assertEq(again.tokens[3].token, d.tokens[3].token);
    }

    /// The price writer is never the deployer, and the file must name one.
    function test_kit_refusesTheDeployerAsWriter_andNoWriter() public ready {
        TestnetKit.Config memory c = cfg;
        c.priceWriter = address(kit);
        vm.expectRevert(abi.encodeWithSelector(TestnetKit.WriterIsDeployer.selector, address(kit)));
        kit.deploy(c, address(kit));
        c.priceWriter = address(0);
        vm.expectRevert(TestnetKit.NoPriceWriter.selector);
        kit.deploy(c, address(kit));
        c.priceWriter = writer;
        c.chainId = 4663;
        vm.expectRevert(abi.encodeWithSelector(TestnetKit.WrongChain.selector, 4663, 46_630));
        kit.deploy(c, address(kit));
    }

    /// Robinhood Chain's and Base's mainnets are refused, whatever the file says.
    function test_kit_refusesAMainnet() public ready {
        TestnetKit.Config memory c = cfg;
        uint256[2] memory mainnets = [uint256(4663), 8453];
        for (uint256 i; i < mainnets.length; ++i) {
            vm.chainId(mainnets[i]);
            c.chainId = mainnets[i];
            vm.expectRevert(abi.encodeWithSelector(TestnetKit.MainnetRefused.selector, mainnets[i]));
            kit.deploy(c, address(kit));
        }
    }

    /// Each pool opens at its token's test price, whichever side of the pair the token sits on.
    function test_kit_eachPoolOpensAtItsTestPrice() public ready {
        bool below;
        bool above;
        for (uint256 i; i < d.tokens.length; ++i) {
            address token = d.tokens[i].token;
            if (token < address(cash)) below = true;
            else above = true;
            assertLe(_apartBps(_poolPrice(token), _feedPrice(i)), 1, cfg.tokens[i].symbol);
        }
        assertTrue(below && above, "the file's tokens sit on both sides of the cash");
    }

    // ---- a vault on it

    /// The person's vault buys through Universal Router 2.1.2 and the kit's pool, at the test price less
    /// the pool's fee and its depth, and nothing is left approved.
    function test_vault_ownerBuysThroughTheRouter() public ready {
        uint256 i = _index("tSPY");
        address token = d.tokens[i].token;
        BasketVault vault = _vault(new Weight[](0));
        uint256 minOut = _atFeed(i, 1000e6, 50);
        // Each swap is built before the prank: building it reads the market, and a prank is used by the
        // first call.
        Swap[] memory swaps = _swaps(_buy(token, 1000e6, minOut));
        vm.prank(owner);
        vault.ownerSwap(swaps, type(uint64).max);
        uint256 got = TestStockToken(token).balanceOf(address(vault));
        assertGe(got, minOut);
        assertEq(cash.balanceOf(address(vault)), 9000e6);
        assertEq(cash.allowance(address(vault), PERMIT2), 0);
    }

    /// The keeper rebalances toward the targets at the copied price, inside the vault's tolerance.
    function test_vault_keeperRebalancesThroughTheRouter() public ready {
        uint256 a = _index("tNVDA");
        uint256 b = _index("tGLD");
        Weight[] memory targets = new Weight[](2);
        (targets[0], targets[1]) = d.tokens[a].token < d.tokens[b].token
            ? (Weight(d.tokens[a].token, 4000), Weight(d.tokens[b].token, 3000))
            : (Weight(d.tokens[b].token, 3000), Weight(d.tokens[a].token, 4000));
        BasketVault vault = _vault(targets);
        vm.prank(owner);
        vault.setAutoFollow(true);

        vm.warp(TUESDAY_1500);
        _copy(a, _feedPrice(a));
        _copy(b, _feedPrice(b));
        Swap memory s = _buy(d.tokens[a].token, 4000e6, _atFeed(a, 4000e6, 100));
        vm.prank(keeper);
        (uint256 spent, uint256 received) = vault.keeperSwap(s);
        assertEq(spent, 4000e6);
        assertGe(received, _atFeed(a, 4000e6, 100));
        s = _buy(d.tokens[b].token, 3000e6, _atFeed(b, 3000e6, 100));
        vm.prank(keeper);
        vault.keeperSwap(s);
        assertEq(cash.balanceOf(address(vault)), 3000e6);
    }

    /// A keeper trade the pool fills worse than the test price by more than the tolerance is refused: the
    /// pool was pulled away and not yet re-centred.
    function test_vault_aPoolFarFromItsTestPrice_isRefusedForTheKeeper() public ready {
        uint256 a = _index("tTSLA");
        Weight[] memory targets = new Weight[](1);
        targets[0] = Weight(d.tokens[a].token, 4000);
        BasketVault vault = _vault(targets);
        vm.prank(owner);
        vault.setAutoFollow(true);
        vm.warp(TUESDAY_1500);
        uint256 price = _feedPrice(a);
        // The price moved 3% up and the copier wrote it, but the pool still sits at the old price: a buy
        // there gets more than the feed says; a pool 3% below is what a sale would meet.
        _copy(a, price * 97 / 100);
        Swap memory s = _buy(d.tokens[a].token, 4000e6, 0);
        vm.prank(keeper);
        vm.expectPartialRevert(IBasketVault.ValueTooLow.selector);
        vault.keeperSwap(s);
        vm.prank(writer);
        market.recentre(d.tokens[a].token);
        s = _buy(d.tokens[a].token, 4000e6, _atFeed(a, 4000e6, 100));
        vm.prank(keeper);
        vault.keeperSwap(s);
    }

    // ---- the market

    /// After trades pull a pool away, the price writer moves it back to the test price; a price the copier
    /// writes later moves it again.
    function test_market_recentresToTheTestPrice() public ready {
        uint256 i = _index("tQQQ");
        address token = d.tokens[i].token;
        BasketVault vault = _vault(new Weight[](0));
        Swap[] memory swaps = _swaps(_buy(token, 10_000e6, 0));
        vm.prank(owner);
        vault.ownerSwap(swaps, type(uint64).max);
        assertGt(_apartBps(_poolPrice(token), _feedPrice(i)), market.driftBps(), "the buy moved the pool");

        vm.prank(writer);
        assertTrue(market.recentre(token));
        assertLe(_apartBps(_poolPrice(token), _feedPrice(i)), 1);

        vm.warp(TUESDAY_1500);
        _copy(i, _feedPrice(i) * 102 / 100);
        vm.prank(writer);
        assertTrue(market.recentre(token));
        assertLe(_apartBps(_poolPrice(token), _feedPrice(i)), 1);

        vm.prank(writer);
        assertFalse(market.recentre(token), "a pool at its price is left alone");
    }

    /// Down as well as up, and for a token on the other side of the pair.
    function test_market_recentresBothWays() public ready {
        for (uint256 i; i < d.tokens.length; ++i) {
            address token = d.tokens[i].token;
            vm.warp(KIT_TIME + 120 + i);
            _copy(i, _feedPrice(i) * (i % 2 == 0 ? 95 : 105) / 100);
            vm.prank(writer);
            assertTrue(market.recentre(token));
            assertLe(_apartBps(_poolPrice(token), _feedPrice(i)), 1, cfg.tokens[i].symbol);
        }
    }

    function test_market_onlyTheOwnerOrTheWriterRecentres() public ready {
        address token = d.tokens[0].token;
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(TestMarket.NotOperator.selector, stranger));
        market.recentre(token);
        vm.prank(address(kit));
        assertFalse(market.recentre(token));
    }

    function test_market_onlyTheOwnerOpensSeedsAndSetsFeeds() public ready {
        address token = d.tokens[0].token;
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, writer);
        vm.startPrank(writer);
        vm.expectRevert(err);
        market.open(token);
        vm.expectRevert(err);
        market.seed(token, 1e6);
        vm.expectRevert(err);
        market.setFeed(token, stranger);
        vm.expectRevert(err);
        market.setOperator(writer);
        vm.stopPrank();
    }

    /// Only the PoolManager calls back into the market.
    function test_market_onlyThePoolManagerCallsBack() public ready {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(TestMarket.NotPoolManager.selector, stranger));
        market.unlockCallback(abi.encode(uint8(1), d.tokens[0].token, uint256(1e18)));
    }

    /// The pool's key is predictable: someone may open it first at another price. While it is empty, `open`
    /// moves it to the test price for nothing, and the market seeds it there.
    function test_market_anEmptyPoolOpenedElsewhere_isMovedToItsTestPrice() public ready {
        TestStockToken extra = new TestStockToken("Extra", "tXTR", 18, address(kit));
        TestPriceFeed feed = new TestPriceFeed(8, "tXTR / USD (test network)", address(kit), writer);
        vm.prank(writer);
        feed.write(100e8, block.timestamp);
        vm.startPrank(address(kit));
        extra.grantRole(extra.MINTER_ROLE(), d.market);
        market.setFeed(address(extra), address(feed));
        vm.stopPrank();
        PoolKey memory k = market.poolKey(address(extra));
        uint160 target = market.testSqrtPrice(address(extra));
        uint160 elsewhere = uint160(uint256(target) * 11 / 10);
        (bool ok,) = cfg.poolManager.call(
            abi.encodeWithSignature("initialize((address,address,uint24,int24,address),uint160)", k, elsewhere)
        );
        assertTrue(ok);
        assertGt(market.driftOf(address(extra)), 2000);
        vm.startPrank(address(kit));
        market.open(address(extra));
        assertLe(market.driftOf(address(extra)), 1);
        market.seed(address(extra), 1_000e6);
        vm.stopPrank();
        assertGt(market.poolLiquidity(address(extra)), 0);
        assertEq(extra.balanceOf(d.market), 0);
    }

    /// A pool that holds liquidity away from the test price is not taken: `open` refuses it.
    function test_market_aPoolWithLiquidityAwayFromItsPrice_isRefused() public ready {
        uint256 i = _index("tMSFT");
        address token = d.tokens[i].token;
        BasketVault vault = _vault(new Weight[](0));
        Swap[] memory swaps = _swaps(_buy(token, 10_000e6, 0));
        vm.prank(owner);
        vault.ownerSwap(swaps, type(uint64).max);
        uint160 current = market.poolSqrtPrice(token);
        uint160 target = market.testSqrtPrice(token);
        vm.prank(address(kit));
        vm.expectRevert(abi.encodeWithSelector(TestMarket.PoolOpenElsewhere.selector, token, current, target));
        market.open(token);
    }

    function test_market_aTokenWithoutAFeed_hasNoPrice() public ready {
        vm.expectRevert(abi.encodeWithSelector(TestMarket.NoFeed.selector, stranger));
        market.testSqrtPrice(stranger);
    }

    /// The pool and the market hold no stock of their own beyond the pool's liquidity: what the market takes
    /// out of a re-centring swap it burns.
    function test_market_holdsNothing() public ready {
        uint256 i = _index("tAAPL");
        address token = d.tokens[i].token;
        BasketVault vault = _vault(new Weight[](0));
        Swap[] memory swaps = _swaps(_buy(token, 5000e6, 0));
        vm.prank(owner);
        vault.ownerSwap(swaps, type(uint64).max);
        vm.prank(writer);
        market.recentre(token);
        assertEq(TestStockToken(token).balanceOf(d.market), 0);
        assertEq(cash.balanceOf(d.market), 0);
    }

    function _swaps(Swap memory s) internal pure returns (Swap[] memory list) {
        list = new Swap[](1);
        list[0] = s;
    }
}

/// On the test chain, with the real PoolManager's code and Universal Router built from source.
contract TestnetKitTest is TestnetKitWorld {
    using stdJson for string;

    function _chain() internal override returns (bool) {
        return _localChain();
    }

    /// The fixture is the code the test network runs.
    function test_fixture_isThePoolManagersCode() public view {
        string memory fixture = vm.readFile("test/fixtures/v4-pool-manager.json");
        assertEq(keccak256(fixture.readBytes(".runtime")), fixture.readBytes32(".codeHash"));
        assertEq(fixture.readAddress(".address"), cfg.poolManager);
    }
}

/// On a fork of the live test network, when `RH_TESTNET_FORK_URL` is set. Sends nothing.
contract TestnetKitForkTest is TestnetKitWorld {
    function _chain() internal override returns (bool) {
        string memory url = vm.envOr("RH_TESTNET_FORK_URL", string(""));
        if (bytes(url).length == 0) return false;
        vm.createSelectFork(url);
        return true;
    }
}

/// Universal Router as the kit deploys it: the 2.1.2 build, and on a fork of Robinhood Chain mainnet the
/// same code as the router there, byte for byte outside its immutables.
contract UniversalRouterBuildTest is Test {
    using stdJson for string;

    address internal constant MAINNET_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    string internal constant ARTIFACT = "script/testnet/UniversalRouter-2.1.2.json";

    function _build() internal returns (address router) {
        TestnetKit kit = new TestnetKit();
        TestnetKit.Config memory cfg = kit.readConfig("script/testnet/config/46630.json");
        bytes memory init = abi.encodePacked(cfg.router.creationCode, kit.routerArgs(cfg));
        assembly ("memory-safe") {
            router := create(0, add(init, 0x20), mload(init))
        }
        assertTrue(router != address(0), "the creation code deploys");
    }

    /// Its size is the build's, 24,380 bytes, as on mainnet.
    function test_router_buildsFromTheCommittedCode() public {
        assertEq(_build().code.length, vm.readFile(ARTIFACT).readUint(".runtimeSize"));
    }

    /// With `RH_FORK_URL` set: equal to mainnet's 2.1.2 everywhere but its immutables.
    function test_router_isMainnets2_1_2_outsideItsImmutables() public {
        string memory url = vm.envOr("RH_FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        bytes memory built = _build().code;
        bytes memory real = MAINNET_ROUTER.code;
        assertEq(built.length, real.length);
        uint256[] memory starts = vm.readFile(ARTIFACT).readUintArray(".immutableStarts");
        for (uint256 i; i < starts.length; ++i) {
            for (uint256 j; j < 32; ++j) {
                built[starts[i] + j] = 0;
                real[starts[i] + j] = 0;
            }
        }
        assertEq(keccak256(built), keccak256(real));
    }
}
