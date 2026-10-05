#!/usr/bin/env node
// Shows that each rule in the contracts bites: takes one check out at a time, runs the test that should
// catch it, and expects that test to fail.
//
//   node contracts/script/rules-bite.mjs                every rule, one at a time
//   node contracts/script/rules-bite.mjs swap           only the rules whose id contains "swap"
//   node contracts/script/rules-bite.mjs --from 40 --count 20   rules 40 to 59 of those, to run it in pieces
//   node contracts/script/rules-bite.mjs --jobs 3       three at a time: three compilers side by side, each
//                                                       taking a few gigabytes; only on a machine with room
//   node contracts/script/rules-bite.mjs --check        only that each rule's text and test still exist
//
// It never edits the checkout. It works on copies of the project in a temporary folder (under TMPDIR), one
// per job, each with its own build cache, and removes them at the end. So it can run while the sources are
// being edited, and the copies are of the files as they are on disk when it starts. With RULES_BITE_DIR set
// to a folder, the copies are made there, refreshed from the checkout at each start and kept, so a run in
// pieces compiles from a warm cache.
//
// Foundry 1.8 has `forge test --mutate` for this; the pinned toolchain is older.
// A rule added to the contracts gets a line here in the same pull request.
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..');
const VAULT = 'src/BasketVault.sol';
const CONFIG = 'src/VaultConfig.sol';
const FACTORY = 'src/VaultFactory.sol';
const REGISTRY = 'src/IndexRegistry.sol';
const BEACON = 'src/VaultBeacon.sol';
const TEST_TOKEN = 'src/testnet/TestToken.sol';
const TEST_STOCK = 'src/testnet/TestStockToken.sol';
const TEST_FEED = 'src/testnet/TestPriceFeed.sol';
const TEST_SEQUENCER = 'src/testnet/StubSequencerFeed.sol';
const TEST_MARKET = 'src/testnet/TestMarket.sol';
const KIT = 'script/testnet/TestnetKit.s.sol';
const COPIER = 'script/testnet/CopyPrices.s.sol';

const WITHDRAW =
  'function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {';
const WITHDRAW_ALL = 'function withdrawAll() external onlyOwner nonReentrant returns';
const DEPOSIT = 'function deposit(uint256 amount) external onlyOwner nonReentrant {';
const OWNER_SWAP =
  'function ownerSwap(Swap[] calldata swaps, uint64 deadline) external onlyOwner nonReentrant {';
const SET_TARGETS =
  'function setTargets(Weight[] calldata targets_) external onlyOwner nonReentrant {';
const START_GATE =
  'require(msg.sender == address($.config) && CREATING.asBoolean().tload(), IBasketVault.NotCreating());';
const PAY_OWNER = 'IERC20(token).safeTransfer(_vault().owner, amount);';
const PULL_CASH = 'IERC20(cash).safeTransferFrom(from, address(this), amount);';
const SHORTFALL =
  'require(received >= amount, IBasketVault.DepositShortfall(cash, amount, received));';
const OUTPUT_OK =
  'require(s.tokenOut != s.tokenIn && cfg.isAsset(s.tokenOut), IBasketVault.TokenNotAccepted(s.tokenOut));';
const ROUTER_OK = 'router != address(this) && router != PERMIT2 && !$.tokens.contains(router),';
const TRADED_READABLE =
  'require(!traded || (was != UNREADABLE && left != UNREADABLE), IBasketVault.BalanceUnreadable(token));';
const RECEIVED =
  'require(received >= s.minOut, IBasketVault.ReceivedTooLittle(token, received, s.minOut));';
const TOKEN_RESET = 'IERC20(token).forceApprove(spender, 0);';
const PERMIT2_RESET = 'IPermit2(PERMIT2).approve(token, router, 0, 0);';
const VIEWS = '    // ---- views\n';
const KEEPER_AUTO_FOLLOW =
  'require(msg.sender == cfg.keeper(), NotKeeper(msg.sender));\n        require($.autoFollow, AutoFollowOff());';
const ADOPT_AUTO_FOLLOW =
  'require($.autoFollow, AutoFollowOff());\n        require(!$.config.keeperPaused(), KeeperPaused());';
const CASH_LEG =
  'leg.cash != address(0) && inIsCash != (s.tokenOut == leg.cash), NotCashLeg(s.tokenIn, s.tokenOut)';
const DEADLINE =
  'require(block.timestamp <= deadline, DeadlinePassed(deadline, uint64(block.timestamp)));';
const RESERVED =
  'return target == PERMIT2 || target == address(this) || target == _config().registry;';
const FACTORY_RESERVED =
  'return super._isReserved(target) || target == $.beacon || $.isVault[target];';
const CANCEL_WHO =
  'msg.sender == index.creator || msg.sender == $.factory.guardian() || msg.sender == $.factory.admin(),';
const DELETE_WAITING = 'delete index.slots[slot];';
const VECTORS = 'test_A16_creatorLimits_everySharedVector';
const HANDOVER = `    function transferOwnership(address newOwner) public override(Ownable, Ownable2Step) {
        Ownable2Step.transferOwnership(newOwner);
    }`;
const NO_RENOUNCE = `    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }`;

const admin = (signature) => ({
  find: `${signature} external onlyAdmin {`,
  replace: `${signature} external {`,
});
const guardian = (signature) => ({
  find: `${signature} external onlyGuardian {`,
  replace: `${signature} external {`,
});

// find: text that occurs exactly once in the file. replace: the same code with the rule taken out.
// expect: a test that must fail without the rule.
const RULES = [
  // ---- the vault: who may call, and who is paid
  {
    id: 'vault-owner-withdraw',
    file: VAULT,
    find: WITHDRAW,
    replace: WITHDRAW.replace('onlyOwner ', ''),
    expect: 'test_I1_withdraw_revertsForAnyoneButTheOwner',
  },
  {
    id: 'vault-owner-withdrawAll',
    file: VAULT,
    find: WITHDRAW_ALL,
    replace: WITHDRAW_ALL.replace('onlyOwner ', ''),
    expect: 'test_I1_withdraw_revertsForAnyoneButTheOwner',
  },
  {
    id: 'vault-owner-deposit',
    file: VAULT,
    find: DEPOSIT,
    replace: DEPOSIT.replace('onlyOwner ', ''),
    expect: 'test_deposit_revertsForStranger',
  },
  {
    id: 'vault-owner-ownerSwap',
    file: VAULT,
    find: OWNER_SWAP,
    replace: OWNER_SWAP.replace('onlyOwner ', ''),
    expect: 'test_ownerSwap_revertsForAnyoneButTheOwner',
  },
  {
    id: 'vault-owner-setTargets',
    file: VAULT,
    find: SET_TARGETS,
    replace: SET_TARGETS.replace('onlyOwner ', ''),
    expect: 'test_setTargets_revertsForAnyoneButTheOwner',
  },
  {
    id: 'vault-owner-check-itself',
    file: VAULT,
    find: 'require(msg.sender == _vault().owner, IBasketVault.NotOwner(msg.sender));',
    replace: '',
    expect: 'invariant_I1_tokensLeaveOnlyByTheOwnersCall',
  },
  {
    id: 'vault-withdraw-pays-stored-owner',
    file: VAULT,
    find: PAY_OWNER,
    replace: 'IERC20(token).safeTransfer(address(0xdead), amount);',
    expect: 'test_withdraw_paysTheOwner',
  },
  {
    id: 'vault-sweep-pays-stored-owner',
    file: VAULT,
    find: 'address to = $.owner;',
    replace: 'address to = address(0xdead);',
    expect: 'test_withdrawAll_sendsEverythingToTheOwner',
  },
  {
    id: 'vault-no-fallback',
    file: VAULT,
    find: VIEWS,
    replace: `    fallback() external {}\n\n${VIEWS}`,
    expect: 'test_I1_entryPoints_areExactlyThese',
  },
  {
    id: 'vault-no-receive',
    file: VAULT,
    find: VIEWS,
    replace: `    receive() external payable {}\n\n${VIEWS}`,
    expect: 'test_I1_entryPoints_areExactlyThese',
  },
  {
    id: 'vault-no-new-entry-point',
    file: VAULT,
    find: VIEWS,
    replace: `    function sweep(address to) external onlyOwner {}\n\n${VIEWS}`,
    expect: 'test_I1_entryPoints_areExactlyThese',
  },
  {
    id: 'vault-no-erc1271',
    file: VAULT,
    find: VIEWS,
    replace: `    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {\n        return 0x1626ba7e;\n    }\n\n${VIEWS}`,
    expect: 'test_isValidSignature_isAbsent',
  },
  // ---- the vault: initialise, and `start` in the creating transaction only
  {
    id: 'vault-init-logic-disabled',
    file: VAULT,
    find: '_disableInitializers();',
    replace: '',
    expect: 'test_A15_initialize_revertsOnLogicContract',
  },
  {
    id: 'vault-init-once',
    file: VAULT,
    find: 'function initialize(address owner_, bytes32 planId_) external initializer {',
    replace: 'function initialize(address owner_, bytes32 planId_) external {',
    expect: 'test_A15_initialize_revertsOnLiveProxy',
  },
  {
    id: 'vault-init-zero-owner',
    file: VAULT,
    find: 'require(owner_ != address(0), IBasketVault.ZeroAddress());',
    replace: '',
    expect: 'test_initialize_revertsOnZeroOwner',
  },
  {
    id: 'vault-init-config-is-the-creator',
    file: VAULT,
    find: '$.config = IVaultConfig(msg.sender);',
    replace: '$.config = IVaultConfig(owner_);',
    expect: 'test_initialize_takesItsCreatorAsTheConfig',
  },
  {
    id: 'vault-start-factory-only',
    file: VAULT,
    find: START_GATE,
    replace: START_GATE.replace('msg.sender == address($.config) && ', ''),
    expect: 'test_start_answersOnlyTheCreatorAndOnlyOnce',
  },
  {
    id: 'vault-start-creating-transaction-only',
    file: VAULT,
    find: START_GATE,
    replace: START_GATE.replace(' && CREATING.asBoolean().tload()', ''),
    expect: 'test_start_revertsForTheFactoryOnceTheVaultIsMade',
  },
  {
    id: 'vault-start-later-transaction',
    file: VAULT,
    find: START_GATE,
    replace: START_GATE.replace(' && CREATING.asBoolean().tload()', ''),
    expect: 'test_start_revertsInAnyLaterTransaction',
  },
  {
    id: 'vault-start-once',
    file: VAULT,
    find: 'CREATING.asBoolean().tstore(false);',
    replace: '',
    expect: 'test_start_answersOnlyTheCreatorAndOnlyOnce',
  },
  {
    id: 'vault-start-no-targets-with-a-portfolio',
    file: VAULT,
    find: 'require(targets_.length == 0, IBasketVault.InvalidTargets(6));',
    replace: '',
    expect: 'test_createVault_revertsOnTargetsTogetherWithAPortfolio',
  },
  {
    id: 'vault-start-cash-from-the-owner',
    file: VAULT,
    find: 'if (cashAmount != 0) _pullCash($, $.owner, cashAmount);',
    replace: 'if (cashAmount != 0) _pullCash($, msg.sender, cashAmount);',
    expect: 'test_createVaultAndBuy_pullsFromTheOwnerOnly',
  },
  // ---- the vault: the cash token comes in
  {
    id: 'vault-deposit-cash-is-set',
    file: VAULT,
    find: 'require(cash != address(0), IBasketVault.CashTokenNotSet());',
    replace: '',
    expect: 'test_deposit_revertsWhenNoCashTokenIsSet',
  },
  {
    id: 'vault-deposit-tracks-cash',
    file: VAULT,
    find: '$.tokens.add(cash);',
    replace: '',
    expect: 'test_deposit_pullsTheCashTokenAndTracksIt',
  },
  {
    id: 'vault-deposit-shortfall',
    file: VAULT,
    find: SHORTFALL,
    replace: '',
    expect: 'test_deposit_feeOnTransferCash_isRejected',
  },
  {
    id: 'vault-first-buy-shortfall',
    file: VAULT,
    find: SHORTFALL,
    replace: '',
    expect: 'test_createVaultAndBuy_feeOnTransferCash_isRejected',
  },
  {
    id: 'vault-deposit-false-return',
    file: VAULT,
    find: PULL_CASH,
    replace: 'cash.call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));',
    expect: 'test_deposit_cashTokenReturningFalse',
  },
  // ---- the vault: following a shared portfolio (A18)
  {
    id: 'vault-follow-registry-is-set',
    file: VAULT,
    find: 'require(registry != address(0), IBasketVault.RegistryNotSet());',
    replace: '',
    expect: 'test_createVault_revertsOnAPortfolioWhenNoRegistryIsSet',
  },
  {
    id: 'vault-follow-portfolio-exists',
    file: VAULT,
    find: 'require(version != 0, IBasketVault.IndexNotFound(indexId));',
    replace: '',
    expect: 'test_createVault_revertsOnAPortfolioThatDoesNotExist',
  },
  {
    id: 'vault-follow-version-reviewed',
    file: VAULT,
    find: 'require(version == expectedVersion, IBasketVault.VersionMismatch(indexId, expectedVersion, version));',
    replace: '',
    expect: 'test_A18_createSignedAgainstAnOlderVersion_reverts',
  },
  // ---- the vault: the owner's own targets
  {
    id: 'vault-targets-at-most-16',
    file: VAULT,
    find: 'require(list.length <= MAX_TARGETS, IBasketVault.InvalidTargets(1));',
    replace: '',
    expect: 'test_setTargets_revertsOnTargetsThatAreNotAllowed',
  },
  {
    id: 'vault-targets-sorted-each-once',
    file: VAULT,
    find: 'require(i == 0 || token > last, IBasketVault.InvalidTargets(2));',
    replace: '',
    expect: 'test_setTargets_revertsOnTargetsThatAreNotAllowed',
  },
  {
    id: 'vault-targets-listed',
    file: VAULT,
    find: 'require(cfg.isAsset(token), IBasketVault.InvalidTargets(3));',
    replace: '',
    expect: 'test_setTargets_revertsOnTargetsThatAreNotAllowed',
  },
  {
    id: 'vault-targets-not-cash',
    file: VAULT,
    find: 'require(token != cash, IBasketVault.InvalidTargets(4));',
    replace: '',
    expect: 'test_setTargets_revertsOnTargetsThatAreNotAllowed',
  },
  {
    id: 'vault-targets-not-cash-at-create',
    file: VAULT,
    find: 'require(token != cash, IBasketVault.InvalidTargets(4));',
    replace: '',
    expect: 'test_createVault_revertsOnTargetsThatAreNotAllowed',
  },
  {
    id: 'vault-targets-at-most-the-whole',
    file: VAULT,
    find: 'require(total <= BPS, IBasketVault.InvalidTargets(5));',
    replace: '',
    expect: 'test_setTargets_revertsOnTargetsThatAreNotAllowed',
  },
  {
    id: 'vault-targets-stop-following',
    file: VAULT,
    find: '$.indexId = bytes32(0);',
    replace: '',
    expect: 'test_setTargets_storesThemAndStopsFollowing',
  },
  {
    id: 'vault-targets-auto-follow-off',
    file: VAULT,
    find: '$.autoFollow = false;',
    replace: '',
    expect: 'test_setTargets_switchesAutoFollowOff',
  },
  // ---- the vault: the owner's swap, judged by the vault's own balances
  {
    id: 'vault-swap-input-was-listed',
    file: VAULT,
    find: 'require(cfg.wasAsset(s.tokenIn), IBasketVault.TokenNotAccepted(s.tokenIn));',
    replace: '',
    expect: 'test_ownerSwap_revertsOnAnInputThatWasNeverListed',
  },
  {
    id: 'vault-swap-output-is-listed',
    file: VAULT,
    find: OUTPUT_OK,
    replace: OUTPUT_OK.replace(' && cfg.isAsset(s.tokenOut)', ''),
    expect: 'test_ownerSwap_revertsOnAnOutputThatIsNotListed',
  },
  {
    id: 'vault-swap-removed-asset-not-bought',
    file: VAULT,
    find: OUTPUT_OK,
    replace: OUTPUT_OK.replace(' && cfg.isAsset(s.tokenOut)', ''),
    expect: 'test_ownerSwap_aRemovedAssetCanBeSoldAndNotBought',
  },
  {
    id: 'vault-swap-output-is-another-token',
    file: VAULT,
    find: OUTPUT_OK,
    replace: OUTPUT_OK.replace('s.tokenOut != s.tokenIn && ', ''),
    expect: 'test_ownerSwap_revertsOnAnOutputThatIsNotListed',
  },
  {
    id: 'vault-swap-tracks-the-input',
    file: VAULT,
    find: '$.tokens.add(s.tokenIn);',
    replace: '',
    expect: 'test_ownerSwap_aTokenSentInFromOutside_isTrackedOnceTraded',
  },
  {
    id: 'vault-swap-tracks-the-output',
    file: VAULT,
    find: '$.tokens.add(s.tokenOut);',
    replace: '',
    expect: 'test_ownerSwap_direct_buysAndTracksTheOutput',
  },
  {
    id: 'vault-first-buy-tracks-the-output',
    file: VAULT,
    find: '$.tokens.add(s.tokenOut);',
    replace: '',
    expect: 'test_createVaultAndBuy_depositsAndBuysInOneCall',
  },
  {
    id: 'vault-swap-router-allowed',
    file: VAULT,
    find: 'require(pulls[i] != 0, IBasketVault.RouterNotAllowed(s.router));',
    replace: '',
    expect: 'test_ownerSwap_revertsOnARouterThatIsNotAllowed',
  },
  {
    id: 'vault-swap-router-is-not-the-vault',
    file: VAULT,
    find: ROUTER_OK,
    replace: ROUTER_OK.replace('router != address(this) && ', ''),
    expect: 'test_hostile_permit2OrTheVaultAsRouter_isRefusedTwice',
  },
  {
    id: 'vault-swap-router-is-not-permit2',
    file: VAULT,
    find: ROUTER_OK,
    replace: ROUTER_OK.replace('router != PERMIT2 && ', ''),
    expect: 'test_hostile_permit2OrTheVaultAsRouter_isRefusedTwice',
  },
  {
    id: 'vault-swap-router-is-not-a-held-token',
    file: VAULT,
    find: ROUTER_OK,
    replace: ROUTER_OK.replace(' && !$.tokens.contains(router)', ''),
    expect: 'test_hostile_approveAsItsSwap_isRefusedTwice',
  },
  {
    id: 'vault-swap-router-is-not-a-token-bought-later',
    file: VAULT,
    find: ROUTER_OK,
    replace: ROUTER_OK.replace(' && !$.tokens.contains(router)', ''),
    expect: 'test_hostile_approveAsItsSwap_onATokenBoughtLaterInTheBatch_isRefused',
  },
  {
    id: 'vault-swap-router-failure-fails',
    file: VAULT,
    find: 'require(ok, IBasketVault.RouterFailed(s.router, reason));',
    replace: '',
    expect: 'test_ownerSwap_aRouterThatReverts_failsWithItsReason',
  },
  {
    id: 'vault-swap-spent-at-most-amountIn',
    file: VAULT,
    find: 'require(spent <= s.amountIn, IBasketVault.SpentTooMuch(token, spent, s.amountIn));',
    replace: '',
    expect: 'test_hostile_takesMoreThanAmountIn',
  },
  {
    id: 'vault-swap-received-at-least-minOut',
    file: VAULT,
    find: RECEIVED,
    replace: '',
    expect: 'test_hostile_paysLessThanMinOut',
  },
  {
    id: 'vault-swap-output-to-the-vault',
    file: VAULT,
    find: RECEIVED,
    replace: '',
    expect: 'test_A1_hostile_sendsTheOutputElsewhere',
  },
  {
    id: 'vault-swap-output-is-the-named-token',
    file: VAULT,
    find: RECEIVED,
    replace: '',
    expect: 'test_hostile_paysADifferentToken',
  },
  {
    id: 'vault-first-buy-received-at-least-minOut',
    file: VAULT,
    find: RECEIVED,
    replace: '',
    expect: 'test_createVaultAndBuy_aFailedSwapLeavesNothing',
  },
  {
    id: 'vault-swap-no-other-token-debited',
    file: VAULT,
    find: 'require(left != UNREADABLE && left >= was, IBasketVault.OtherTokenDebited(token, was, left));',
    replace: '',
    expect: 'test_hostile_drainsAnotherToken',
  },
  {
    id: 'vault-swap-other-token-still-readable',
    file: VAULT,
    find: 'require(left != UNREADABLE && left >= was, IBasketVault.OtherTokenDebited(token, was, left));',
    replace: 'require(left >= was, IBasketVault.OtherTokenDebited(token, was, left));',
    expect: 'test_hostile_makesAnotherTokenUnreadable',
  },
  {
    id: 'vault-swap-output-readable-after',
    file: VAULT,
    find: TRADED_READABLE,
    replace: TRADED_READABLE.replace(' && left != UNREADABLE', ''),
    expect: 'test_hostile_theOutputStopsAnsweringMidSwap_isRefused',
  },
  {
    id: 'vault-swap-input-readable-after',
    file: VAULT,
    find: TRADED_READABLE,
    replace: TRADED_READABLE.replace(' && left != UNREADABLE', ''),
    expect: 'test_hostile_theInputStopsAnsweringMidSwap_isRefused',
  },
  {
    id: 'vault-swap-input-readable-before',
    file: VAULT,
    find: TRADED_READABLE,
    replace: TRADED_READABLE.replace('was != UNREADABLE && ', ''),
    expect: 'test_ownerSwap_anInputUnreadableBeforeTheSwap_isRefused',
  },
  {
    id: 'vault-swap-traded-tokens-readable',
    file: VAULT,
    find: TRADED_READABLE,
    replace: '',
    expect: 'test_ownerSwap_anUnreadableTokenBlocksOnlyItsOwnTrades',
  },
  {
    id: 'vault-swap-frozen-token-does-not-block',
    file: VAULT,
    find: '} else if (was != UNREADABLE) {',
    replace: '} else {',
    expect: 'test_ownerSwap_anUnreadableTokenBlocksOnlyItsOwnTrades',
  },
  {
    id: 'vault-swap-batch-each-swap-has-its-minimum',
    file: VAULT,
    find: RECEIVED,
    replace: '',
    expect: 'test_ownerSwap_batch_runsInOrderOrNotAtAll',
  },
  // ---- the vault: the approval is exact, and gone afterwards (A11, I3)
  {
    id: 'vault-swap-exact-approval-direct',
    file: VAULT,
    find: 'IERC20(token).forceApprove(router, amount);',
    replace: 'IERC20(token).forceApprove(router, type(uint256).max);',
    expect: 'test_exactApproval_direct_aLargerPullFailsAtTheToken',
  },
  {
    id: 'vault-swap-exact-approval-to-permit2',
    file: VAULT,
    find: 'IERC20(token).forceApprove(PERMIT2, amount);',
    replace: 'IERC20(token).forceApprove(PERMIT2, type(uint256).max);',
    expect: 'test_exactApproval_permit2_theTokenAllowanceIsExact',
  },
  {
    id: 'vault-swap-exact-approval-inside-permit2',
    file: VAULT,
    find: 'SafeCast.toUint160(amount), uint48(block.timestamp)',
    replace: 'type(uint160).max, uint48(block.timestamp)',
    expect: 'test_exactApproval_permit2_theAmountInsidePermit2IsExact',
  },
  {
    id: 'vault-swap-permit2-approval-ends-with-the-block',
    file: VAULT,
    find: 'SafeCast.toUint160(amount), uint48(block.timestamp)',
    replace: 'SafeCast.toUint160(amount), type(uint48).max',
    expect: 'test_exactApproval_permit2_endsWithTheBlock',
  },
  {
    id: 'vault-swap-permit2-amount-not-cut-down',
    file: VAULT,
    find: 'SafeCast.toUint160(amount), uint48(block.timestamp)',
    replace: 'uint160(amount), uint48(block.timestamp)',
    expect: 'test_ownerSwap_permit2_revertsOnAnAmountItCannotHold',
  },
  {
    id: 'vault-swap-pull-mode-is-the-configs',
    file: VAULT,
    find: 'if (pull == PULL_PERMIT2) {\n            IERC20(token).forceApprove(PERMIT2, amount);',
    replace: 'if (pull != 0) {\n            IERC20(token).forceApprove(PERMIT2, amount);',
    expect: 'test_ownerSwap_pullModeIsTheConfigs',
  },
  {
    id: 'vault-swap-token-allowance-taken-back',
    file: VAULT,
    find: TOKEN_RESET,
    replace: '',
    expect: 'test_A11_routerTakesLess_noAllowanceIsLeft',
  },
  {
    id: 'vault-swap-token-allowance-read-back',
    file: VAULT,
    find: 'require(onToken == 0, IBasketVault.AllowanceLeft(token, spender, onToken));',
    replace: '',
    expect: 'test_A11_aTokenThatKeepsItsAllowance_failsTheSwap',
  },
  {
    id: 'vault-swap-permit2-allowance-taken-back',
    file: VAULT,
    find: PERMIT2_RESET,
    replace: '',
    expect: 'test_A11_routerTakesLess_noAllowanceIsLeft',
  },
  {
    id: 'vault-swap-permit2-allowance-read-back',
    file: VAULT,
    find: 'require(inPermit2 == 0, IBasketVault.AllowanceLeft(token, router, inPermit2));',
    replace: '',
    expect: 'test_A11_aPermit2ThatKeepsItsAllowance_failsTheSwap',
  },
  {
    id: 'vault-i3-token-allowance',
    file: VAULT,
    find: `${TOKEN_RESET}\n        uint256 onToken = IERC20(token).allowance(address(this), spender);\n        require(onToken == 0, IBasketVault.AllowanceLeft(token, spender, onToken));`,
    replace: '',
    expect: 'invariant_I3_noAllowanceSurvives',
  },
  {
    id: 'vault-i3-permit2-allowance',
    file: VAULT,
    find: `${PERMIT2_RESET}\n            (uint160 inPermit2,,) = IPermit2(PERMIT2).allowance(address(this), token, router);\n            require(inPermit2 == 0, IBasketVault.AllowanceLeft(token, router, inPermit2));`,
    replace: '',
    expect: 'invariant_I3_noAllowanceSurvives',
  },
  // ---- the vault: withdraw and the sweep
  {
    id: 'vault-withdraw-false-return',
    file: VAULT,
    find: PAY_OWNER,
    replace: 'token.call(abi.encodeCall(IERC20.transfer, (_vault().owner, amount)));',
    expect: 'test_withdraw_tokenReturningFalse',
  },
  {
    id: 'vault-sweep-skips-a-failed-transfer',
    file: VAULT,
    find: 'if (!readable || !_tryTransfer(list[i], to, held)) {',
    replace: 'if (readable) IERC20(list[i]).safeTransfer(to, held);\n            if (!readable) {',
    expect: 'test_A9_frozenToken_doesNotBlockTheOthers',
  },
  {
    id: 'vault-sweep-skips-an-unreadable-balance',
    file: VAULT,
    find: '(bool readable, uint256 held) = _tryBalanceOf(list[i]);',
    replace: '(bool readable, uint256 held) = (true, IERC20(list[i]).balanceOf(address(this)));',
    expect: 'test_A9_tokenWhoseBalanceReadReverts_isSkipped',
  },
  {
    id: 'vault-sweep-balance-is-a-full-word',
    file: VAULT,
    find: 'ok := and(ok, gt(returndatasize(), 0x1f))',
    replace: '',
    expect: 'test_A9_tokenWhoseBalanceReadIsShortOrAbsent_isSkipped',
  },
  {
    id: 'vault-sweep-balance-needs-an-answer',
    file: VAULT,
    find: 'ok := and(ok, gt(returndatasize(), 0x1f))',
    replace: '',
    expect: 'test_A9_tokenWhoseCodeIsGone_isSkipped',
  },
  {
    id: 'vault-sweep-transfer-must-say-true',
    file: VAULT,
    find: 'let saidTrue := and(gt(size, 0x1f), eq(mload(0x00), 1))',
    replace: 'let saidTrue := gt(size, 0x1f)',
    expect: 'test_A9_frozenToken_doesNotBlockTheOthers',
  },
  {
    id: 'vault-sweep-announces-a-skip',
    file: VAULT,
    find: 'emit IBasketVault.WithdrawSkipped(list[i]);',
    replace: '',
    expect: 'test_A9_frozenToken_doesNotBlockTheOthers',
  },
  {
    id: 'vault-sweep-gas-reserve',
    file: VAULT,
    find: 'require(gasleft() >= SWEEP_RESERVE, IBasketVault.GasTooLow(gasleft(), SWEEP_RESERVE));',
    replace: '',
    expect: 'test_withdrawAll_neverSkipsAHealthyTokenForLackOfGas',
  },
  {
    id: 'vault-sweep-gas-reserve-says-so',
    file: VAULT,
    find: 'require(gasleft() >= SWEEP_RESERVE, IBasketVault.GasTooLow(gasleft(), SWEEP_RESERVE));',
    replace: '',
    expect: 'test_withdrawAll_saysSoWhenGasIsShort',
  },
  {
    id: 'vault-sweep-gas-reserve-is-large-enough',
    file: VAULT,
    find: 'SWEEP_RESERVE = 420_000;',
    replace: 'SWEEP_RESERVE = 320_000;',
    expect: 'test_withdrawAll_neverSkipsAHealthyTokenForLackOfGas',
  },
  {
    id: 'vault-sweep-transfer-gas-cap',
    file: VAULT,
    find: 'ok := call(SWEEP_TRANSFER_GAS, token, 0, 0x00, 0x44, 0x00, 0x20)',
    replace: 'ok := call(gas(), token, 0, 0x00, 0x44, 0x00, 0x20)',
    expect: 'test_withdrawAll_tokensThatBurnTheirGas_costABoundedAmount',
  },
  {
    id: 'vault-sweep-balance-gas-cap',
    file: VAULT,
    find: 'ok := staticcall(SWEEP_BALANCE_GAS, token, 0x00, 0x24, 0x00, 0x20)',
    replace: 'ok := staticcall(gas(), token, 0x00, 0x24, 0x00, 0x20)',
    expect: 'test_withdrawAll_tokensThatBurnTheirGas_costABoundedAmount',
  },
  // ---- the vault: one reentrancy guard, and `multicall` outside it (A17)
  {
    id: 'vault-reentrancy-withdraw',
    file: VAULT,
    find: WITHDRAW,
    replace: WITHDRAW.replace(' nonReentrant', ''),
    expect: 'test_reentrantCall_isRefused',
  },
  {
    id: 'vault-reentrancy-withdrawAll',
    file: VAULT,
    find: WITHDRAW_ALL,
    replace: WITHDRAW_ALL.replace(' nonReentrant', ''),
    expect: 'test_reentrantCall_isRefused',
  },
  {
    id: 'vault-reentrancy-deposit',
    file: VAULT,
    find: DEPOSIT,
    replace: DEPOSIT.replace(' nonReentrant', ''),
    expect: 'test_reentrantCall_isRefused',
  },
  {
    id: 'vault-reentrancy-ownerSwap',
    file: VAULT,
    find: OWNER_SWAP,
    replace: OWNER_SWAP.replace(' nonReentrant', ''),
    expect: 'test_A17_reentryMidSwap_isRefused',
  },
  {
    id: 'vault-reentrancy-setTargets',
    file: VAULT,
    find: SET_TARGETS,
    replace: SET_TARGETS.replace(' nonReentrant', ''),
    expect: 'test_A17_reentryMidSwap_isRefused',
  },
  {
    id: 'vault-reentrancy-withdraw-mid-swap',
    file: VAULT,
    find: WITHDRAW,
    replace: WITHDRAW.replace(' nonReentrant', ''),
    expect: 'test_A17_reentryMidSwap_isRefused',
  },
  {
    id: 'vault-reentrancy-start',
    file: VAULT,
    find: ') external nonReentrant {\n        VaultStorage storage $ = _vault();\n        require(msg.sender == address($.config)',
    replace:
      ') external {\n        VaultStorage storage $ = _vault();\n        require(msg.sender == address($.config)',
    expect: 'test_A17_reentryDuringTheFirstBuy_isRefused',
  },
  {
    id: 'vault-multicall-is-outside-the-guard',
    file: VAULT,
    find: '        override(MulticallUpgradeable, IBasketVault)\n        returns (bytes[] memory)',
    replace:
      '        override(MulticallUpgradeable, IBasketVault)\n        nonReentrant\n        returns (bytes[] memory)',
    expect: 'test_multicall_batchesTheOwnersCalls',
  },
  // ---- the config: who may change it
  {
    id: 'config-admin-setAsset',
    file: CONFIG,
    find: 'function setAsset(address token, AssetConfig calldata cfg) external onlyAdmin {',
    replace: 'function setAsset(address token, AssetConfig calldata cfg) external {',
    expect: 'test_setAsset_revertsForNonAdmin',
  },
  {
    id: 'config-admin-setRouter',
    file: CONFIG,
    ...admin('function setRouter(address router, uint8 pull)'),
    expect: 'test_setRouter_revertsForNonAdmin',
  },
  {
    id: 'config-admin-setCashToken',
    file: CONFIG,
    ...admin('function setCashToken(address token)'),
    expect: 'test_setCashToken_revertsForNonAdmin',
  },
  {
    id: 'config-admin-removeAsset',
    file: CONFIG,
    ...admin('function removeAsset(address token)'),
    expect: 'test_removeAsset_revertsForNonAdmin',
  },
  {
    id: 'config-admin-setRegistry',
    file: CONFIG,
    ...admin('function setRegistry(address registry_)'),
    expect: 'test_setRegistry_isSetOnceByTheAdmin',
  },
  {
    id: 'config-admin-setKeeper',
    file: CONFIG,
    ...admin('function setKeeper(address keeper_)'),
    expect: 'test_setKeeper_revertsForNonAdmin',
  },
  {
    id: 'config-admin-setGuardian',
    file: CONFIG,
    ...admin('function setGuardian(address guardian_)'),
    expect: 'test_setGuardian_revertsForNonAdmin',
  },
  {
    id: 'config-admin-setSequencerFeed',
    file: CONFIG,
    ...admin('function setSequencerFeed(address feed)'),
    expect: 'test_setSequencerFeed_revertsForNonAdmin',
  },
  {
    id: 'config-admin-setParams',
    file: CONFIG,
    ...admin('function setParams(Params calldata p)'),
    expect: 'test_setParams_revertsForNonAdmin',
  },
  {
    id: 'config-admin-unpauseKeeper',
    file: CONFIG,
    ...admin('function unpauseKeeper()'),
    expect: 'test_unpauseKeeper_isTheAdminsAlone',
  },
  {
    id: 'config-admin-setHalt',
    file: CONFIG,
    ...admin('function setHalt(address token, uint64 until)'),
    expect: 'test_setHalt_isTheAdminsAlone',
  },
  {
    id: 'config-admin-setClosedUntil',
    file: CONFIG,
    ...admin('function setClosedUntil(uint64 until)'),
    expect: 'test_setClosedUntil_isTheAdminsAlone',
  },
  {
    id: 'config-admin-setClosedDay',
    file: CONFIG,
    ...admin('function setClosedDay(uint32 day, bool closed)'),
    expect: 'test_closedDays_theGuardianAddsAndOnlyTheAdminRemoves',
  },
  {
    id: 'config-admin-launch',
    file: CONFIG,
    ...admin('function launch()'),
    expect: 'test_launch_isOneWayAndTheAdmins',
  },
  {
    id: 'config-admin-proposeAdmin',
    file: CONFIG,
    ...admin('function proposeAdmin(address next)'),
    expect: 'test_proposeAdmin_revertsForNonAdmin',
  },
  {
    id: 'config-admin-check-itself',
    file: CONFIG,
    find: 'require(msg.sender == _config().admin, NotAdmin(msg.sender));',
    replace: '',
    expect: 'test_setAsset_revertsForNonAdmin',
  },
  {
    id: 'config-accept-pending-only',
    file: CONFIG,
    find: 'require(msg.sender == $.pendingAdmin, NotPendingAdmin(msg.sender));',
    replace: '',
    expect: 'test_acceptAdmin_revertsForAnyoneButThePendingAdmin',
  },
  {
    id: 'config-accept-after-cancel',
    file: CONFIG,
    find: 'require(msg.sender == $.pendingAdmin, NotPendingAdmin(msg.sender));',
    replace: '',
    expect: 'test_proposeAdmin_zeroCancelsAProposal',
  },
  {
    id: 'config-init-zero-admin',
    file: CONFIG,
    find: 'require(admin_ != address(0), ZeroAddress());',
    replace: '',
    expect: 'test_init_revertsOnZeroAdmin',
  },
  {
    id: 'config-init-params-in-bounds',
    file: CONFIG,
    find: '_setParams(params_);',
    replace: '_config().params = params_;',
    expect: 'test_init_holdsTheParamsToTheirBounds',
  },
  // ---- the config: the guardian tightens, and only that
  {
    id: 'config-guardian-pauseKeeper',
    file: CONFIG,
    ...guardian('function pauseKeeper()'),
    expect: 'test_pauseKeeper_revertsForAnyoneElse',
  },
  {
    id: 'config-guardian-haltAsset',
    file: CONFIG,
    ...guardian('function haltAsset(address token, uint64 until)'),
    expect: 'test_haltAsset_revertsForAnyoneButTheGuardianOrTheAdmin',
  },
  {
    id: 'config-guardian-extendClosedUntil',
    file: CONFIG,
    ...guardian('function extendClosedUntil(uint64 until)'),
    expect: 'test_extendClosedUntil_onlyTightens',
  },
  {
    id: 'config-guardian-addClosedDay',
    file: CONFIG,
    ...guardian('function addClosedDay(uint32 day)'),
    expect: 'test_closedDays_theGuardianAddsAndOnlyTheAdminRemoves',
  },
  {
    id: 'config-guardian-check-itself',
    file: CONFIG,
    find: 'require(msg.sender == $.guardian || msg.sender == $.admin, NotGuardian(msg.sender));',
    replace: '',
    expect: 'test_pauseKeeper_revertsForAnyoneElse',
  },
  {
    id: 'config-halt-only-tightens',
    file: CONFIG,
    find: 'require(until > stored, OnlyTighten(stored, until));',
    replace: '',
    expect: 'test_haltAsset_onlyTightens',
  },
  {
    id: 'config-halt-asset-is-known',
    file: CONFIG,
    find: 'require($.assetList.contains(token) || $.removed.contains(token), AssetNotListed(token));',
    replace: '',
    expect: 'test_haltAsset_revertsOnATokenThatWasNeverListed',
  },
  {
    id: 'config-closed-only-tightens',
    file: CONFIG,
    find: 'require(until > $.closedUntil, OnlyTighten($.closedUntil, until));',
    replace: '',
    expect: 'test_extendClosedUntil_onlyTightens',
  },
  {
    id: 'config-launch-no-admin-handover-pending',
    file: CONFIG,
    find: 'require($.pendingAdmin == address(0), AdminHandoverPending($.pendingAdmin));',
    replace: '',
    expect: 'test_launch_revertsWhileAnAdminHandoverIsProposed',
  },
  {
    id: 'config-launch-no-admin-handover-pending-on-the-factory',
    file: CONFIG,
    find: 'require($.pendingAdmin == address(0), AdminHandoverPending($.pendingAdmin));',
    replace: '',
    expect: 'test_launch_revertsWhileAnAdminHandoverIsPending',
  },
  {
    id: 'config-launch-one-way',
    file: CONFIG,
    find: 'require(!$.launched, AlreadyLaunched());',
    replace: '',
    expect: 'test_launch_isOneWayAndTheAdmins',
  },
  // ---- the config: the keeper's limits
  {
    id: 'config-params-tolerance',
    file: CONFIG,
    find: 'require(p.toleranceBps <= MAX_TOLERANCE_BPS, ParamOutOfBounds("toleranceBps", p.toleranceBps));',
    replace: '',
    expect: 'test_setParams_revertsOnToleranceAbove300',
  },
  {
    id: 'config-params-loss-cap',
    file: CONFIG,
    find: 'require(p.lossCapBps <= MAX_LOSS_CAP_BPS, ParamOutOfBounds("lossCapBps", p.lossCapBps));',
    replace: '',
    expect: 'test_setParams_revertsOnLossCapAbove500',
  },
  {
    id: 'config-params-cooldown',
    file: CONFIG,
    find: 'require(p.assetCooldown >= MIN_ASSET_COOLDOWN, ParamOutOfBounds("assetCooldown", p.assetCooldown));',
    replace: '',
    expect: 'test_setParams_revertsOnCooldownUnder600',
  },
  {
    id: 'config-params-session-within-a-day',
    file: CONFIG,
    find: 'require(p.sessionClose <= DAY, ParamOutOfBounds("sessionClose", p.sessionClose));',
    replace: '',
    expect: 'test_setParams_revertsOnASessionPastMidnight',
  },
  {
    id: 'config-params-session-opens-before-it-closes',
    file: CONFIG,
    find: 'require(p.sessionOpen < p.sessionClose, ParamOutOfBounds("sessionOpen", p.sessionOpen));',
    replace: '',
    expect: 'test_setParams_revertsOnASessionThatClosesBeforeItOpens',
  },
  // ---- the config: assets
  {
    id: 'config-asset-zero-token',
    file: CONFIG,
    find: 'require(token != address(0), ZeroAddress());',
    replace: '',
    expect: 'test_setAsset_revertsOnZeroToken',
  },
  {
    id: 'config-asset-has-code',
    file: CONFIG,
    find: 'require(token.code.length != 0, NoCode(token));',
    replace: '',
    expect: 'test_setAsset_revertsOnAnAddressWithNoCode',
  },
  {
    id: 'config-asset-is-not-a-router',
    file: CONFIG,
    find: 'require($.routerPull[token] == 0, AssetIsRouter(token));',
    replace: '',
    expect: 'test_setAsset_revertsOnAnAllowedRouter',
  },
  {
    id: 'config-asset-source',
    file: CONFIG,
    find: 'require(cfg.source <= MAX_SOURCE, ParamOutOfBounds("source", cfg.source));',
    replace: '',
    expect: 'test_setAsset_revertsOnUnknownSource',
  },
  {
    id: 'config-asset-session',
    file: CONFIG,
    find: 'require(cfg.session <= MAX_SESSION, ParamOutOfBounds("session", cfg.session));',
    replace: '',
    expect: 'test_setAsset_revertsOnUnknownSession',
  },
  {
    id: 'config-asset-token-decimals',
    file: CONFIG,
    find: 'require(cfg.tokenDecimals <= MAX_DECIMALS, ParamOutOfBounds("tokenDecimals", cfg.tokenDecimals));',
    replace: '',
    expect: 'test_setAsset_revertsOnTokenDecimalsAbove18',
  },
  {
    id: 'config-asset-feed-decimals',
    file: CONFIG,
    find: 'require(cfg.feedDecimals <= MAX_DECIMALS, ParamOutOfBounds("feedDecimals", cfg.feedDecimals));',
    replace: '',
    expect: 'test_setAsset_revertsOnFeedDecimalsAbove18',
  },
  {
    id: 'config-asset-max-weight',
    file: CONFIG,
    find: 'require(cfg.maxWeightBps <= MAX_ASSET_WEIGHT_BPS, ParamOutOfBounds("maxWeightBps", cfg.maxWeightBps));',
    replace: '',
    expect: 'test_setAsset_revertsOnWeightAboveHalf',
  },
  {
    id: 'config-asset-feed-required',
    file: CONFIG,
    find: 'require(cfg.source == 0 || cfg.feed != address(0), FeedRequired(token));',
    replace: '',
    expect: 'test_setAsset_revertsWhenAPricedAssetHasNoFeed',
  },
  {
    id: 'config-asset-price-age-min',
    file: CONFIG,
    find: 'require(cfg.maxAge >= MIN_PRICE_AGE, ParamOutOfBounds("maxAge", cfg.maxAge));',
    replace: '',
    expect: 'test_setAsset_revertsOnPriceAgeTooShort',
  },
  {
    id: 'config-asset-price-age-max',
    file: CONFIG,
    find: 'require(cfg.maxAge <= MAX_PRICE_AGE, ParamOutOfBounds("maxAge", cfg.maxAge));',
    replace: '',
    expect: 'test_setAsset_revertsOnPriceAgeTooLong',
  },
  {
    id: 'config-asset-keeps-the-halt',
    file: CONFIG,
    find: '$.assets[token].haltUntil = halt;',
    replace: '',
    expect: 'test_setAsset_keepsTheStoredHalt',
  },
  {
    id: 'config-remove-is-listed',
    file: CONFIG,
    find: 'require(wasListed, AssetNotListed(token));',
    replace: '',
    expect: 'test_removeAsset_revertsOnATokenThatIsNotListed',
  },
  {
    id: 'config-remove-not-the-cash-token',
    file: CONFIG,
    find: 'require(token != $.cashToken, CashTokenNotRemovable(token));',
    replace: '',
    expect: 'test_removeAsset_revertsOnTheCashToken',
  },
  {
    id: 'config-remove-is-remembered',
    file: CONFIG,
    find: '$.removed.add(token);',
    replace: '',
    expect: 'test_removeAsset_takesItOffTheListAndKeepsItsSettings',
  },
  {
    id: 'config-remove-takes-it-off-the-list',
    file: CONFIG,
    find: 'bool wasListed = $.assetList.remove(token);',
    replace: 'bool wasListed = $.assetList.contains(token);',
    expect: 'test_removeAsset_takesItOffTheListAndKeepsItsSettings',
  },
  {
    id: 'config-relist-is-no-longer-removed',
    file: CONFIG,
    find: '$.removed.remove(token);',
    replace: '',
    expect: 'test_removeAsset_listingItAgainPutsItBack',
  },
  // ---- the config: routers, the registry and the cash token
  {
    id: 'config-router-zero',
    file: CONFIG,
    find: 'require(router != address(0), ZeroAddress());',
    replace: '',
    expect: 'test_setRouter_revertsOnZeroRouter',
  },
  {
    id: 'config-router-pull-range',
    file: CONFIG,
    find: 'require(pull <= MAX_PULL, InvalidPull(pull));',
    replace: '',
    expect: 'test_setRouter_revertsOnUnknownPull',
  },
  {
    id: 'config-router-has-code',
    file: CONFIG,
    find: 'require(router.code.length != 0, NoCode(router));',
    replace: '',
    expect: 'test_setRouter_revertsOnAnAddressWithNoCode',
  },
  {
    id: 'config-router-is-not-an-asset',
    file: CONFIG,
    find: 'require(!$.assetList.contains(router) && !$.removed.contains(router), RouterIsAsset(router));',
    replace: 'require(!$.removed.contains(router), RouterIsAsset(router));',
    expect: 'test_setRouter_revertsOnAListedAsset',
  },
  {
    id: 'config-router-is-not-a-removed-asset',
    file: CONFIG,
    find: 'require(!$.assetList.contains(router) && !$.removed.contains(router), RouterIsAsset(router));',
    replace: 'require(!$.assetList.contains(router), RouterIsAsset(router));',
    expect: 'test_setRouter_revertsOnARemovedAsset',
  },
  {
    id: 'config-router-is-not-a-token',
    file: CONFIG,
    find: 'require(!_answersAllowance(router), RouterIsToken(router));',
    replace: '',
    expect: 'test_setRouter_revertsOnAnythingThatAnswersAsAToken',
  },
  {
    id: 'config-router-is-not-reserved',
    file: CONFIG,
    find: 'require(!_isReserved(router), RouterReserved(router));',
    replace: '',
    expect: 'test_setRouter_revertsOnPermit2AndOnTheConfigItself',
  },
  {
    id: 'config-router-is-not-permit2',
    file: CONFIG,
    find: RESERVED,
    replace: RESERVED.replace('target == PERMIT2 || ', ''),
    expect: 'test_setRouter_revertsOnPermit2AndOnTheConfigItself',
  },
  {
    id: 'config-router-is-not-permit2-on-the-factory',
    file: CONFIG,
    find: RESERVED,
    replace: RESERVED.replace('target == PERMIT2 || ', ''),
    expect: 'test_hostile_permit2OrTheVaultAsRouter_isRefusedTwice',
  },
  {
    id: 'config-router-is-not-the-config',
    file: CONFIG,
    find: RESERVED,
    replace: RESERVED.replace('target == address(this) || ', ''),
    expect: 'test_setRouter_revertsOnPermit2AndOnTheConfigItself',
  },
  {
    id: 'config-router-is-not-the-registry',
    file: CONFIG,
    find: RESERVED,
    replace: RESERVED.replace(' || target == _config().registry', ''),
    expect: 'test_setRouter_revertsOnPermit2AndOnTheConfigItself',
  },
  {
    id: 'config-router-removal-always-works',
    file: CONFIG,
    find: 'if (pull != 0) {',
    replace: '{',
    expect: 'test_setRouter_removesARouterWhoseCodeIsGone',
  },
  {
    id: 'config-registry-set-once',
    file: CONFIG,
    find: 'require($.registry == address(0), RegistryAlreadySet($.registry));',
    replace: '',
    expect: 'test_setRegistry_isSetOnceByTheAdmin',
  },
  {
    id: 'config-registry-zero',
    file: CONFIG,
    find: 'require(registry_ != address(0), ZeroAddress());',
    replace: '',
    expect: 'test_setRegistry_revertsOnZero',
  },
  {
    id: 'config-registry-has-code',
    file: CONFIG,
    find: 'require(registry_.code.length != 0, NoCode(registry_));',
    replace: '',
    expect: 'test_setRegistry_revertsOnAnAddressWithNoCode',
  },
  {
    id: 'config-registry-is-not-a-router',
    file: CONFIG,
    find: 'require($.routerPull[registry_] == 0, RouterReserved(registry_));',
    replace: '',
    expect: 'test_setRegistry_revertsOnAnAllowedRouter',
  },
  {
    id: 'config-cash-is-listed',
    file: CONFIG,
    find: 'require($.assetList.contains(token), AssetNotListed(token));',
    replace: '',
    expect: 'test_setCashToken_revertsOnAnythingNotListed',
  },
  // ---- the factory
  {
    id: 'factory-init-logic-disabled',
    file: FACTORY,
    find: '_disableInitializers();',
    replace: '',
    expect: 'test_A15_initialize_revertsOnTheLogicContractAndOnTheLiveProxy',
  },
  // No row for `initializer` on the factory's `initialize`. With it removed, the config's `onlyInitializing`
  // refuses every initialisation, so nothing can be set up at all: that shows a broken build, not a test
  // that holds the rule. The rule is held twice; the vault's and the registry's have rows that bite.
  {
    id: 'factory-init-beacon-zero',
    file: FACTORY,
    find: 'require(beacon_ != address(0), ZeroAddress());',
    replace: '',
    expect: 'test_initialize_revertsWithoutABeacon',
  },
  {
    id: 'factory-init-beacon-has-code',
    file: FACTORY,
    find: 'require(beacon_.code.length != 0, NoCode(beacon_));',
    replace: '',
    expect: 'test_initialize_revertsWithoutABeacon',
  },
  {
    id: 'factory-init-params-in-bounds',
    file: CONFIG,
    find: '_setParams(params_);',
    replace: '_config().params = params_;',
    expect: 'test_initialize_holdsTheParamsToTheirBounds',
  },
  {
    id: 'factory-owner-is-the-caller',
    file: FACTORY,
    find: 'address owner = msg.sender;',
    replace: 'address owner = tx.origin;',
    expect: 'test_createVault_strangerCannotCreateSomeoneElsesVault',
  },
  {
    id: 'factory-one-vault-per-plan',
    file: FACTORY,
    find: 'require($.bySalt[owner][salt] == address(0), VaultExists($.bySalt[owner][salt]));',
    replace: '',
    expect: 'test_createVault_revertsOnAPlanTheOwnerAlreadyUsed',
  },
  {
    id: 'factory-lists-the-vault',
    file: FACTORY,
    find: '$.isVault[vault] = true;',
    replace: '',
    expect: 'test_createVault_isListed',
  },
  {
    id: 'factory-lists-every-vault',
    file: FACTORY,
    find: '$.vaults.push(vault);',
    replace: '',
    expect: 'test_createVault_isListed',
  },
  {
    id: 'factory-lists-by-owner',
    file: FACTORY,
    find: '$.byOwner[owner].push(vault);',
    replace: '',
    expect: 'test_createVault_isListed',
  },
  {
    id: 'factory-remembers-the-address',
    file: FACTORY,
    find: '$.bySalt[owner][salt] = vault;',
    replace: '',
    expect: 'test_createVault_revertsOnAPlanTheOwnerAlreadyUsed',
  },
  {
    id: 'factory-launch-beacon-is-the-admins',
    file: FACTORY,
    find: 'require(beaconOwner == admin() && pending == address(0), BeaconNotTheAdmins(beaconOwner, pending));',
    replace: 'require(pending == address(0), BeaconNotTheAdmins(beaconOwner, pending));',
    expect: 'test_launch_revertsWhileTheBeaconIsNotTheAdmins',
  },
  {
    id: 'factory-launch-no-beacon-handover-pending',
    file: FACTORY,
    find: 'require(beaconOwner == admin() && pending == address(0), BeaconNotTheAdmins(beaconOwner, pending));',
    replace: 'require(beaconOwner == admin(), BeaconNotTheAdmins(beaconOwner, pending));',
    expect: 'test_launch_revertsWhileABeaconHandoverIsPending',
  },
  {
    id: 'factory-launch-checks-the-beacon',
    file: CONFIG,
    find: '_checkLaunch();',
    replace: '',
    expect: 'test_launch_revertsWhileTheBeaconIsNotTheAdmins',
  },
  {
    id: 'factory-upgrade-is-the-admins',
    file: FACTORY,
    find: '_checkAdmin();',
    replace: '',
    expect: 'test_A15_upgrade_keepsStateAndIsTheAdmins',
  },
  {
    id: 'factory-router-is-not-the-beacon',
    file: FACTORY,
    find: FACTORY_RESERVED,
    replace: FACTORY_RESERVED.replace(' || target == $.beacon', ''),
    expect: 'test_setRouter_revertsOnTheBeaconAndOnAVault',
  },
  {
    id: 'factory-router-is-not-a-vault',
    file: FACTORY,
    find: FACTORY_RESERVED,
    replace: FACTORY_RESERVED.replace(' || $.isVault[target]', ''),
    expect: 'test_setRouter_revertsOnTheBeaconAndOnAVault',
  },
  // ---- the registry: the four author limits, rule by rule (A16)
  {
    id: 'registry-limit-01-fee-not-zero',
    file: REGISTRY,
    find: 'require(maxFeeBps == 0, CreatorLimit(FEE_NOT_ZERO));',
    replace: '',
    expect: VECTORS,
  },
  {
    id: 'registry-limit-02-flags-not-zero',
    file: REGISTRY,
    find: 'require(flags == 0, CreatorLimit(FLAGS_NOT_ZERO));',
    replace: '',
    expect: VECTORS,
  },
  {
    id: 'registry-limit-03-too-few-assets',
    file: REGISTRY,
    find: 'if (c.length < MIN_ASSETS) return (CreatorLimit.selector, TOO_FEW_ASSETS, 0);',
    replace: '',
    expect: VECTORS,
  },
  {
    id: 'registry-limit-04-too-many-assets',
    file: REGISTRY,
    find: 'if (c.length > MAX_ASSETS) return (CreatorLimit.selector, TOO_MANY_ASSETS, 0);',
    replace: '',
    expect: VECTORS,
  },
  {
    id: 'registry-limit-05-asset-not-listed',
    file: REGISTRY,
    find: 'if (!platform.isAsset(token)) reason = _first(reason, ASSET_NOT_LISTED);',
    replace: '',
    expect: VECTORS,
  },
  {
    id: 'registry-limit-06-duplicate-asset',
    file: REGISTRY,
    find: 'if (i != 0 && token == c[i - 1].token) reason = _first(reason, DUPLICATE_ASSET);',
    replace: '',
    expect: VECTORS,
  },
  {
    id: 'registry-limit-07-weight-below-min',
    file: REGISTRY,
    find: 'if (bps < MIN_WEIGHT_BPS) reason = _first(reason, WEIGHT_BELOW_MIN);',
    replace: '',
    expect: VECTORS,
  },
  {
    id: 'registry-limit-08-weight-off-step',
    file: REGISTRY,
    find: 'if (bps % STEP_BPS != 0) reason = _first(reason, WEIGHT_OFF_STEP);',
    replace: '',
    expect: VECTORS,
  },
  {
    id: 'registry-limit-09-weight-above-the-assets-ceiling',
    file: REGISTRY,
    find: 'if (bps > (ceiling < MAX_WEIGHT_BPS ? ceiling : MAX_WEIGHT_BPS)) {',
    replace: 'if (bps > MAX_WEIGHT_BPS) {',
    expect: VECTORS,
  },
  {
    id: 'registry-limit-09-weight-above-half',
    file: REGISTRY,
    find: 'if (bps > (ceiling < MAX_WEIGHT_BPS ? ceiling : MAX_WEIGHT_BPS)) {',
    replace: 'if (bps > ceiling) {',
    expect: VECTORS,
  },
  {
    id: 'registry-limit-10-weight-sum',
    file: REGISTRY,
    find: 'if (sum != SUM_BPS) reason = _first(reason, WEIGHT_SUM);',
    replace: '',
    expect: VECTORS,
  },
  {
    id: 'registry-limit-11-version-pending',
    file: REGISTRY,
    find: 'if (_hasWaiting(index)) reason = _first(reason, VERSION_PENDING);',
    replace: '',
    expect: VECTORS,
  },
  {
    id: 'registry-limit-12-version-too-soon',
    file: REGISTRY,
    find: 'if (block.timestamp < index.lastPublishAt + delay) reason = _first(reason, VERSION_TOO_SOON);',
    replace: '',
    expect: VECTORS,
  },
  {
    id: 'registry-limit-13-turnover-too-high',
    file: REGISTRY,
    find: 'if (moved > 2 * uint256(MAX_TURNOVER_BPS)) reason = _first(reason, TURNOVER_TOO_HIGH);',
    replace: '',
    expect: VECTORS,
  },
  {
    id: 'registry-limit-14-cash-not-allowed',
    file: REGISTRY,
    find: 'if (token == cash) reason = _first(reason, CASH_NOT_ALLOWED);',
    replace: '',
    expect: VECTORS,
  },
  {
    id: 'registry-limit-lowest-rule-is-the-reason',
    file: REGISTRY,
    find: 'return found == 0 || rule < found ? rule : found;',
    replace: 'return rule;',
    expect: VECTORS,
  },
  {
    id: 'registry-turnover-against-the-version-in-effect',
    file: REGISTRY,
    find: 'uint256 moved = _moved(index.slots[_inEffect(index)].components, c);',
    replace: 'uint256 moved = _moved(index.slots[0].components, c);',
    expect: VECTORS,
  },
  {
    id: 'registry-later-version-waits-one-delay',
    file: REGISTRY,
    find: 'effectiveAt = uint64(block.timestamp) + delay;\n        version = _store(',
    replace: 'effectiveAt = uint64(block.timestamp);\n        version = _store(',
    expect: VECTORS,
  },
  {
    id: 'registry-preview-says-the-same',
    file: REGISTRY,
    find: '(err, reason, turnoverBps) = _check($, index, next, delay);',
    replace: '',
    expect: VECTORS,
  },
  {
    id: 'registry-preview-names-the-end-of-the-wait',
    file: REGISTRY,
    find: 'if (later == bytes4(0)) allowedAt = index.lastPublishAt + delay;',
    replace: '',
    expect: VECTORS,
  },
  {
    id: 'registry-preview-names-a-time-only-when-waiting-is-all',
    file: REGISTRY,
    find: 'if (later == bytes4(0)) allowedAt = index.lastPublishAt + delay;',
    replace: 'allowedAt = index.lastPublishAt + delay;',
    expect: VECTORS,
  },
  {
    id: 'registry-preview-names-no-time-past-a-later-rule',
    file: REGISTRY,
    find: 'if (later == bytes4(0)) allowedAt = index.lastPublishAt + delay;',
    replace: 'allowedAt = index.lastPublishAt + delay;',
    expect: 'test_previewPublish_namesNoTimeWhenWaitingWouldNotBeEnough',
  },
  {
    id: 'registry-cancel-does-not-give-the-slot-back',
    file: REGISTRY,
    find: DELETE_WAITING,
    replace: `index.lastPublishAt = 0;\n        ${DELETE_WAITING}`,
    expect: VECTORS,
  },
  {
    id: 'registry-cancel-does-not-give-the-number-back',
    file: REGISTRY,
    find: DELETE_WAITING,
    replace: `--index.lastVersion;\n        ${DELETE_WAITING}`,
    expect: 'test_cancel_byTheCreatorTheGuardianOrTheAdmin',
  },
  // ---- the registry: who may publish and cancel, and what a read answers
  {
    id: 'registry-list-is-sorted',
    file: REGISTRY,
    find: 'if (c[i].token < c[i - 1].token) return (NotSorted.selector, 0, 0);',
    replace: '',
    expect: 'test_unsortedList_isRefusedEverywhere',
  },
  {
    id: 'registry-create-once',
    file: REGISTRY,
    find: 'require(index.creator == address(0), IndexExists(id));',
    replace: '',
    expect: 'test_create_idIsTheCreatorAndTheFamily',
  },
  {
    id: 'registry-portfolio-exists',
    file: REGISTRY,
    find: 'require(index.creator != address(0), IndexNotFound(id));',
    replace: '',
    expect: 'test_publish_revertsOnAnIdThatDoesNotExist',
  },
  {
    id: 'registry-publish-creator-only',
    file: REGISTRY,
    find: 'require(msg.sender == index.creator, NotCreator(msg.sender));',
    replace: '',
    expect: 'test_publish_revertsForAnyoneButTheCreator',
  },
  {
    id: 'registry-cancel-creator-or-guardian',
    file: REGISTRY,
    find: CANCEL_WHO,
    replace: 'true,',
    expect: 'test_cancel_revertsForAStranger',
  },
  {
    id: 'registry-cancel-only-a-waiting-version',
    file: REGISTRY,
    find: 'require(_hasWaiting(index), NothingPending(id));',
    replace: '',
    expect: 'test_cancel_revertsWhenNothingIsWaiting',
  },
  {
    id: 'registry-in-effect-is-the-newer-version',
    file: REGISTRY,
    find: 'if (aLive && bLive) return a.version > b.version ? 0 : 1;',
    replace: 'if (aLive && bLive) return 0;',
    expect: 'test_publish_waitsOneDelayThenTakesEffectByTheClock',
  },
  {
    id: 'registry-waiting-version-is-not-in-effect',
    file: REGISTRY,
    find: 'bool bLive = b.version != 0 && b.effectiveAt <= block.timestamp;',
    replace: 'bool bLive = b.version != 0;',
    expect: 'test_publish_waitsOneDelayThenTakesEffectByTheClock',
  },
  {
    id: 'registry-stores-the-meta-hash',
    file: REGISTRY,
    find: 'v.metaHash = metaHash;',
    replace: '',
    expect: 'test_metaHash_sixSharedCases',
  },
  // ---- the registry: the delay, the launch latch, and who may replace the code
  {
    id: 'registry-delay-is-the-admins',
    file: REGISTRY,
    find: 'function setPublishDelay(uint32 delay) external onlyAdmin {',
    replace: 'function setPublishDelay(uint32 delay) external {',
    expect: 'test_setPublishDelay_isTheFactoryAdminsAndStaysInBounds',
  },
  {
    id: 'registry-upgrade-is-the-admins',
    file: REGISTRY,
    find: 'function _authorizeUpgrade(address) internal view override onlyAdmin {}',
    replace: 'function _authorizeUpgrade(address) internal view override {}',
    expect: 'test_A15_upgrade_keepsStateAndIsTheFactoryAdmins',
  },
  {
    id: 'registry-admin-check-itself',
    file: REGISTRY,
    find: 'require(msg.sender == _registry().factory.admin(), NotAdmin(msg.sender));',
    replace: '',
    expect: 'test_setPublishDelay_isTheFactoryAdminsAndStaysInBounds',
  },
  {
    id: 'registry-delay-floor',
    file: REGISTRY,
    find: 'require(delay >= _floor($), ParamOutOfBounds("publishDelay", delay));',
    replace: '',
    expect: 'test_setPublishDelay_isTheFactoryAdminsAndStaysInBounds',
  },
  {
    id: 'registry-delay-ceiling',
    file: REGISTRY,
    find: 'require(delay <= MAX_PUBLISH_DELAY, ParamOutOfBounds("publishDelay", delay));',
    replace: '',
    expect: 'test_setPublishDelay_isTheFactoryAdminsAndStaysInBounds',
  },
  {
    id: 'registry-launch-raises-the-floor',
    file: REGISTRY,
    find: 'return $.factory.launched() ? LAUNCHED_PUBLISH_DELAY : MIN_PUBLISH_DELAY;',
    replace: 'return MIN_PUBLISH_DELAY;',
    expect: 'test_launch_raisesTheDelayToItsFloorOf48Hours',
  },
  {
    id: 'registry-floor-is-in-force-at-once',
    file: REGISTRY,
    find: 'return $.publishDelay > floor ? $.publishDelay : floor;',
    replace: 'return $.publishDelay;',
    expect: 'test_launch_aVersionPublishedAfterItWaits48Hours',
  },
  {
    id: 'registry-init-logic-disabled',
    file: REGISTRY,
    find: '_disableInitializers();',
    replace: '',
    expect: 'test_A15_initialize_revertsOnTheRegistrysLogicAndOnItsLiveProxy',
  },
  {
    id: 'registry-init-once',
    file: REGISTRY,
    find: 'function initialize(address factory_, uint32 publishDelay_) external initializer {',
    replace: 'function initialize(address factory_, uint32 publishDelay_) external {',
    expect: 'test_A15_initialize_revertsOnTheRegistrysLogicAndOnItsLiveProxy',
  },
  {
    id: 'registry-init-zero-factory',
    file: REGISTRY,
    find: 'require(factory_ != address(0), ZeroAddress());',
    replace: '',
    expect: 'test_initialize_revertsWithoutAFactoryOrWithADelayOutOfBounds',
  },
  // ---- the beacon
  {
    id: 'beacon-handover-takes-two-steps',
    file: BEACON,
    find: HANDOVER,
    replace: HANDOVER.replace(
      'Ownable2Step.transferOwnership(newOwner);',
      '_transferOwnership(newOwner);',
    ),
    expect: 'test_handover_takesTwoSteps',
  },
  {
    id: 'beacon-handover-owner-only',
    file: BEACON,
    find: HANDOVER,
    replace: HANDOVER.replace(
      'Ownable2Step.transferOwnership(newOwner);',
      '_transferOwnership(newOwner);',
    ),
    expect: 'test_transferOwnership_revertsForAnyoneButTheOwner',
  },
  {
    id: 'beacon-key-cannot-be-given-up',
    file: BEACON,
    find: NO_RENOUNCE,
    replace: '',
    expect: 'test_renounceOwnership_alwaysReverts',
  },

  // ---- the keeper's path (EVM-3): who, when, what
  {
    id: 'keeper-caller',
    file: VAULT,
    find: 'require(msg.sender == cfg.keeper(), NotKeeper(msg.sender));',
    replace: '',
    expect: 'test_A13_aCallerOtherThanTheKeeper_isRefused',
  },
  {
    id: 'keeper-auto-follow',
    file: VAULT,
    find: KEEPER_AUTO_FOLLOW,
    replace: 'require(msg.sender == cfg.keeper(), NotKeeper(msg.sender));',
    expect: 'test_A13_autoFollowOff_isRefused',
  },
  {
    id: 'keeper-paused',
    file: VAULT,
    find: 'require(!cfg.keeperPaused(), KeeperPaused());',
    replace: '',
    expect: 'test_A8_paused_theKeeperIsRefused_andTheOwnerWithdraws',
  },
  {
    id: 'keeper-cash-on-one-side',
    file: VAULT,
    find: CASH_LEG,
    replace: 'true, NotCashLeg(s.tokenIn, s.tokenOut)',
    expect: 'test_keeperSwap_twoAssets_isRefused',
  },
  {
    id: 'keeper-cash-on-one-side-not-both',
    file: VAULT,
    find: CASH_LEG,
    replace: 'true, NotCashLeg(s.tokenIn, s.tokenOut)',
    expect: 'test_keeperSwap_cashForCash_isRefused',
  },
  {
    id: 'keeper-a-target-only',
    file: VAULT,
    find: 'require(isTarget, TokenNotAccepted(leg.asset));',
    replace: '',
    expect: 'test_A4_aTokenOutsideTheTargets_isRefused',
  },
  {
    id: 'keeper-buys-only-a-listed-asset',
    file: VAULT,
    find: 'require(!leg.buying || cfg.isAsset(leg.asset), TokenNotAccepted(leg.asset));',
    replace: '',
    expect: 'test_keeperSwap_aRemovedAsset_canBeSoldAndNotBought',
  },
  {
    id: 'keeper-cooldown',
    file: VAULT,
    find: 'require(block.timestamp >= until, Cooldown(leg.asset, uint64(until)));',
    replace: '',
    expect: 'test_keeperSwap_oneTradePerAssetPerCooldown',
  },
  {
    id: 'keeper-cooldown-stamped',
    file: VAULT,
    find: '$.lastKeeperAt[leg.asset] = uint64(block.timestamp);',
    replace: '',
    expect: 'test_keeperSwap_oneTradePerAssetPerCooldown',
  },
  {
    id: 'keeper-multiplier-window',
    file: VAULT,
    find: 'require(ok && apart >= MULTIPLIER_WINDOW, MultiplierWindow(token, effectiveAt));',
    replace: '',
    expect: 'test_A12_insideTheMultiplierWindow_isRefused',
  },
  {
    id: 'keeper-multiplier-schedule-answers',
    file: VAULT,
    find: 'require(ok && apart >= MULTIPLIER_WINDOW, MultiplierWindow(token, effectiveAt));',
    replace: 'require(!ok || apart >= MULTIPLIER_WINDOW, MultiplierWindow(token, effectiveAt));',
    expect: 'test_A12_insideTheMultiplierWindow_isRefused',
  },
  {
    id: 'keeper-issuer-pause',
    file: VAULT,
    find: 'require(ok && paused == 0, AssetPaused(token));',
    replace: 'require(!ok || paused == 0, AssetPaused(token));',
    expect: 'test_keeperSwap_aTokenItsIssuerPaused_isRefused',
  },
  {
    id: 'keeper-issuer-pause-answers',
    file: VAULT,
    find: 'require(ok && paused == 0, AssetPaused(token));',
    replace: 'require(paused == 0, AssetPaused(token));',
    expect: 'test_keeperSwap_aTokenItsIssuerPaused_isRefused',
  },
  {
    id: 'keeper-halt',
    file: VAULT,
    find: 'require(block.timestamp >= a.haltUntil, AssetHalted(token, a.haltUntil));',
    replace: '',
    expect: 'test_keeperSwap_aHaltedAsset_isRefused',
  },
  {
    id: 'keeper-market-only-for-us-hours',
    file: VAULT,
    find: 'if (a.session == 0) return;',
    replace: '',
    expect: 'test_keeperSwap_anAssetOfAllHours_tradesOnSaturday',
  },
  {
    id: 'keeper-market-weekdays',
    file: VAULT,
    find: 'weekday >= 1 && weekday <= 5 && ',
    replace: '',
    expect: 'test_A6_saturday_isRefused',
  },
  {
    id: 'keeper-market-open',
    file: VAULT,
    find: 'second >= p.sessionOpen && ',
    replace: '',
    expect: 'test_A6_beforeTheOpenAndAtTheClose_areRefused',
  },
  {
    id: 'keeper-market-close',
    file: VAULT,
    find: 'second < p.sessionClose;',
    replace: 'true;',
    expect: 'test_A6_beforeTheOpenAndAtTheClose_areRefused',
  },
  {
    id: 'keeper-market-closed-day',
    file: VAULT,
    find: '!cfg.closedDay(uint32(day)) && ',
    replace: '',
    expect: 'test_A6b_aWeekdayHoliday_isRefused',
  },
  {
    id: 'keeper-market-closed-until',
    file: VAULT,
    find: ' && block.timestamp >= cfg.closedUntil();',
    replace: ';',
    expect: 'test_keeperSwap_beforeClosedUntil_isRefused',
  },
  {
    id: 'keeper-market-checked',
    file: VAULT,
    find: 'require(open, MarketClosed(token));',
    replace: '',
    expect: 'test_A6_saturday_isRefused',
  },
  {
    id: 'keeper-sequencer',
    file: VAULT,
    find: 'require(up, SequencerDown());',
    replace: '',
    expect: 'test_keeperSwap_theSequencerDown_isRefused',
  },
  {
    id: 'keeper-sequencer-up',
    file: VAULT,
    find: 'up = answer == 0 && startedAt',
    replace: 'up = startedAt',
    expect: 'test_keeperSwap_theSequencerDown_isRefused',
  },
  {
    id: 'keeper-sequencer-grace',
    file: VAULT,
    find: ' && block.timestamp - startedAt >= SEQUENCER_GRACE;',
    replace: ';',
    expect: 'test_keeperSwap_theSequencerDown_isRefused',
  },
  // ---- the keeper's path: the price reference (check 8)
  {
    id: 'keeper-price-a-chainlink-feed',
    file: VAULT,
    find: 'require(a.source == 1 && a.feed != address(0), AssetNotPriced(token));',
    replace: '',
    expect: 'test_keeperSwap_noPrice_isRefused',
  },
  {
    id: 'keeper-price-switch',
    file: VAULT,
    find: 'require(a.flags & KEEPER_ON != 0, KeeperAssetOff(token));',
    replace: '',
    expect: 'test_keeperSwap_theSwitchOff_isRefused',
  },
  {
    id: 'keeper-price-an-answer',
    file: VAULT,
    find: 'require(price != 0, AssetNotPriced(token));',
    replace: '',
    expect: 'test_keeperSwap_noPrice_isRefused',
  },
  {
    id: 'keeper-price-above-zero',
    file: VAULT,
    find: 'return signed > 0 ? (uint256(signed), stamp) : (0, 0);',
    replace: 'return (uint256(signed), stamp);',
    expect: 'test_keeperSwap_noPrice_isRefused',
  },
  {
    id: 'keeper-price-a-full-answer',
    file: VAULT,
    find: 'if (!ok || ret.length < 160) return (0, 0);',
    replace: 'if (!ok) return (0, 0);',
    expect: 'test_keeperSwap_noPrice_isRefused',
  },
  {
    id: 'keeper-price-range',
    file: VAULT,
    find: 'require(price >= a.minPrice && price <= a.maxPrice, PriceOutOfRange(token, price));',
    replace: '',
    expect: 'test_keeperSwap_aPriceOutsideItsRange_isRefused',
  },
  {
    id: 'keeper-price-fresh',
    file: VAULT,
    find: 'require(_fresh(updatedAt, a.maxAge), PriceStale(token, updatedAt));',
    replace: '',
    expect: 'test_A5_aStalePrice_isRefused',
  },
  {
    id: 'keeper-price-not-ahead',
    file: VAULT,
    find: ': stamp - block.timestamp <= maxAge;',
    replace: ': true;',
    expect: 'test_A5_aPriceStampedAhead_isRefused',
  },
  {
    id: 'keeper-price-an-average',
    file: VAULT,
    find: 'require(average != 0, AssetNotPriced(token));',
    replace: '',
    expect: 'test_keeperSwap_noPrice_isRefused',
  },
  {
    id: 'keeper-price-average-fresh',
    file: VAULT,
    find: 'require(_fresh(averageAt, a.maxAge), PriceStale(token, averageAt));',
    replace: '',
    expect: 'test_A5_aStaleAverage_isRefused',
  },
  {
    id: 'keeper-price-deviation',
    file: VAULT,
    find: 'apart * BPS <= average * devBps, PriceDeviation',
    replace: 'true, PriceDeviation',
    expect: 'test_keeperSwap_aPriceFarFromItsAverage_isRefused',
  },
  {
    id: 'keeper-price-every-held-target',
    file: VAULT,
    find: 'leg.others += _value(amount, _reference(token, a, devBps), a, leg.cashDecimals);',
    replace: '',
    expect: 'test_A5_anotherHeldTargetsStalePrice_isRefused',
  },
  {
    id: 'keeper-value-every-held-target',
    file: VAULT,
    find: 'leg.others += _value(amount, _reference(token, a, devBps), a, leg.cashDecimals);',
    replace: '',
    expect: 'test_A10_aTargetSentInFromOutside_isValuedAtItsPrice',
  },
  {
    id: 'keeper-price-only-what-is-held',
    file: VAULT,
    find: 'if (amount == 0) continue;',
    replace: '',
    expect: 'test_A5_anotherHeldTargetsStalePrice_isRefused',
  },
  {
    id: 'keeper-other-targets-readable',
    file: VAULT,
    find: 'require(amount != UNREADABLE, BalanceUnreadable(token));',
    replace: '',
    expect: 'test_keeperSwap_aTargetThatCannotBeRead_isRefused',
  },
  {
    id: 'keeper-watches-every-held-target',
    file: VAULT,
    find: '$.tokens.add(token);',
    replace: '',
    expect: 'test_A10_aTargetSentInFromOutside_isValuedAtItsPrice',
  },
  {
    id: 'keeper-asset-readable',
    file: VAULT,
    find: 'require(assetHeld != UNREADABLE, BalanceUnreadable(leg.asset));',
    replace: '',
    expect: 'test_keeperSwap_theAssetOrTheCashUnreadable_isRefused',
  },
  {
    id: 'keeper-cash-readable',
    file: VAULT,
    find: 'require(cashHeld != UNREADABLE, BalanceUnreadable(leg.cash));',
    replace: '',
    expect: 'test_keeperSwap_theAssetOrTheCashUnreadable_isRefused',
  },
  {
    id: 'keeper-largest-value',
    file: VAULT,
    find: 'require(value <= MAX_VALUE, ValueTooLarge(value));',
    replace: '',
    expect: 'test_keeperSwap_aVaultPastTheLargestValue_isRefused',
  },
  {
    id: 'keeper-largest-cash',
    file: VAULT,
    find: 'require(cash <= MAX_VALUE, ValueTooLarge(cash));',
    replace: '',
    expect: 'test_keeperSwap_cashPastTheLargestValue_isRefusedBeforeItIsAdded',
  },
  // ---- the keeper's path: the trade itself
  {
    id: 'keeper-router-allowed',
    file: VAULT,
    find: 'require(pull != 0, RouterNotAllowed(s.router));',
    replace: '',
    expect: 'test_keeperSwap_aRouterNotOnTheList_isRefused',
  },
  {
    id: 'keeper-router-not-reserved',
    file: VAULT,
    find: 's.router != address(this) && s.router != PERMIT2 && !$.tokens.contains(s.router),',
    replace: 'true,',
    expect: 'test_hostile_permit2TheVaultOrATokenAsRouter_isRefusedTwice',
  },
  {
    id: 'keeper-nothing-traded',
    file: VAULT,
    find: 'require(spent != 0, NothingTraded());',
    replace: '',
    expect: 'test_keeperSwap_aRouteThatSpendsNothing_isRefused',
  },
  {
    id: 'keeper-reentry-keeperSwap',
    file: VAULT,
    find: 'function keeperSwap(Swap calldata s) external nonReentrant returns',
    replace: 'function keeperSwap(Swap calldata s) external returns',
    expect: 'test_A17_reentryMidKeeperSwap_isRefused',
  },
  // ---- the keeper's path: checks 4, 5 and 7
  {
    id: 'keeper-value-tolerance',
    file: VAULT,
    find: 'receivedValue * BPS >= spentValue * (BPS - leg.params.toleranceBps),',
    replace: 'true,',
    expect: 'test_A2_aPriceWorseThanTheTolerance_isRefused',
  },
  {
    id: 'keeper-value-tolerance-on-a-sale',
    file: VAULT,
    find: 'receivedValue * BPS >= spentValue * (BPS - leg.params.toleranceBps),',
    replace: 'true,',
    expect: 'test_A2_aSaleWorseThanTheTolerance_isRefused',
  },
  {
    id: 'keeper-value-the-output-to-the-keeper',
    file: VAULT,
    find: 'receivedValue * BPS >= spentValue * (BPS - leg.params.toleranceBps),',
    replace: 'true,',
    expect: 'test_A1_outputSentToTheKeeper_isRefused',
  },
  {
    id: 'keeper-toward-target',
    file: VAULT,
    find: 'require(buying ? weight < target : weight > target, NotTowardTarget(token));',
    replace: '',
    expect: 'test_A7_theWrongDirection_isRefused',
  },
  {
    id: 'keeper-toward-target-not-at-it',
    file: VAULT,
    find: 'require(buying ? weight < target : weight > target, NotTowardTarget(token));',
    replace: 'require(buying ? weight <= target : weight >= target, NotTowardTarget(token));',
    expect: 'test_A7_atTheTarget_neitherWay',
  },
  {
    id: 'keeper-inside-the-band',
    file: VAULT,
    find: 'require(buying ? weight <= limit : weight >= limit, PastTarget(token));',
    replace: '',
    expect: 'test_A7_pastTheBand_isRefused',
  },
  {
    id: 'keeper-inside-the-band-on-a-sale',
    file: VAULT,
    find: 'require(buying ? weight <= limit : weight >= limit, PastTarget(token));',
    replace: '',
    expect: 'test_A7_aSalePastTheBand_isRefused',
  },
  {
    id: 'keeper-no-further',
    file: VAULT,
    find: 'require(offAfter * vaultBefore * factor <= offBefore * vaultAfter, PastTarget(token));',
    replace: '',
    expect: 'test_check5_aCrossingEndsAtMostHalfAsFar',
  },
  {
    id: 'keeper-half-as-far',
    file: VAULT,
    find: 'uint256 factor = crossed ? 2 : 1;',
    replace: 'uint256 factor = 1;',
    expect: 'test_A3_churn_eachCrossingClosesTheDistance',
  },
  {
    id: 'keeper-loss-cap',
    file: VAULT,
    find: 'used * BPS <= leg.vaultValue * leg.params.lossCapBps,',
    replace: 'true,',
    expect: 'test_lossCap_aTradeThatWouldPassTheCap_isRefused',
  },
  {
    id: 'keeper-loss-counted',
    file: VAULT,
    find: '$.lossAccum = used;',
    replace: '',
    expect: 'test_lossCap_aTradeThatWouldPassTheCap_isRefused',
  },
  {
    id: 'keeper-loss-restarts-the-week',
    file: VAULT,
    find: '$.lossTs = uint64(block.timestamp);',
    replace: '',
    expect: 'test_lossCap_theCounterDrainsOverSevenDays',
  },
  {
    id: 'keeper-loss-only-a-loss-counts',
    file: VAULT,
    find: 'if (loss != 0) {',
    replace: 'if (true) {',
    expect: 'test_lossCap_aTradeThatLosesNothing_doesNotRestartTheSevenDays',
  },
  {
    id: 'keeper-loss-drains-to-nothing',
    file: VAULT,
    find: 'if (elapsed >= LOSS_WINDOW) return 0;',
    replace: '',
    expect: 'test_lossCap_aLossRestartsTheSevenDays',
  },
  // ---- following: accept, auto-follow, adopt
  {
    id: 'follow-accept-owner-only',
    file: VAULT,
    find: 'function acceptVersion(bytes32 indexId, uint32 expectedVersion) external onlyOwner nonReentrant {',
    replace:
      'function acceptVersion(bytes32 indexId, uint32 expectedVersion) external nonReentrant {',
    expect: 'test_acceptVersion_isTheOwners',
  },
  {
    id: 'follow-accept-not-the-waiting-version',
    file: VAULT,
    find: 'require(waiting == 0 || waiting != expectedVersion, VersionNotEffective(indexId, expectedVersion));',
    replace: '',
    expect: 'test_acceptVersion_ofTheVersionThatWaits_isRefused',
  },
  {
    id: 'follow-accept-leaves-the-first',
    file: VAULT,
    find: 'if (before != bytes32(0) && before != indexId) emit Unfollowed(address(this), before);',
    replace: '',
    expect: 'test_acceptVersion_ofAnotherPortfolio_leavesTheFirst',
  },
  {
    id: 'follow-auto-follow-owner-only',
    file: VAULT,
    find: 'function setAutoFollow(bool on) external onlyOwner nonReentrant {',
    replace: 'function setAutoFollow(bool on) external nonReentrant {',
    expect: 'test_setAutoFollow_isTheOwnersSwitch',
  },
  {
    id: 'follow-create-with-auto-follow',
    file: VAULT,
    find: 'if (autoFollow_) _setAutoFollow($, true);',
    replace: '',
    expect: 'test_createVault_withAutoFollow_switchesItOn',
  },
  {
    id: 'follow-adopt-auto-follow',
    file: VAULT,
    find: ADOPT_AUTO_FOLLOW,
    replace: 'require(!$.config.keeperPaused(), KeeperPaused());',
    expect: 'test_adoptVersion_autoFollowOff_isRefused',
  },
  {
    id: 'follow-adopt-paused',
    file: VAULT,
    find: 'require(!$.config.keeperPaused(), KeeperPaused());',
    replace: '',
    expect: 'test_adoptVersion_paused_isRefused',
  },
  {
    id: 'follow-adopt-something-followed',
    file: VAULT,
    find: 'require(indexId != bytes32(0), IndexNotFound(indexId));',
    replace: '',
    expect: 'test_adoptVersion_aVaultThatFollowsNothing_isRefused',
  },
  {
    id: 'follow-adopt-only-newer',
    file: VAULT,
    find: 'require(version > $.acceptedVersion, VersionNotEffective(indexId, version));',
    replace: '',
    expect: 'test_adoptVersion_takesAVersionThatOnlyChangesWeights',
  },
  {
    id: 'follow-adopt-no-new-asset',
    file: VAULT,
    find: 'require(_accepts($, components[i].token), NewAssetNeedsOwner(components[i].token));',
    replace: '',
    expect: 'test_A14_aNewAsset_needsTheOwner',
  },
  {
    id: 'follow-adopt-a-dropped-asset-is-not-accepted',
    file: VAULT,
    find: 'return found && bps != 0;',
    replace: 'return found;',
    expect: 'test_A14_anAssetDroppedEarlier_needsTheOwnerToComeBack',
  },
  {
    id: 'follow-adopt-reentry',
    file: VAULT,
    find: 'function adoptVersion() external nonReentrant {',
    replace: 'function adoptVersion() external {',
    expect: 'test_A17_reentryMidKeeperSwap_isRefused',
  },
  {
    id: 'follow-keeps-a-dropped-asset-held',
    file: VAULT,
    find: 'if (_held(token) != 0) $.targets.push(Weight(token, 0));',
    replace: '',
    expect: 'test_acceptVersion_keepsWhatTheVersionDropsWhileItIsHeld',
  },
  {
    id: 'follow-keeps-it-once',
    file: VAULT,
    find: 'if (j < next.length && next[j].token == token) continue;',
    replace: '',
    expect: 'test_acceptVersion_keepsWhatTheVersionDropsWhileItIsHeld',
  },
  {
    id: 'follow-sixteen-at-most',
    file: VAULT,
    find: 'require($.targets.length <= MAX_TARGETS, InvalidTargets(1));',
    replace: '',
    expect: 'test_acceptVersion_moreThanSixteenTargets_isRefused',
  },
  // ---- the deadline on the owner's trades
  {
    id: 'vault-owner-swap-deadline',
    file: VAULT,
    find: DEADLINE,
    replace: '',
    expect: 'test_ownerSwap_isRefusedAfterItsDeadline',
  },
  {
    id: 'factory-create-and-buy-deadline',
    file: FACTORY,
    find: DEADLINE,
    replace: '',
    expect: 'test_createVaultAndBuy_isRefusedAfterItsDeadline',
  },
  // ---- the config: the keeper's switch, the range and the new bounds
  {
    id: 'config-asset-flags',
    file: CONFIG,
    find: 'require(cfg.flags <= KEEPER_ON, ParamOutOfBounds("flags", cfg.flags));',
    replace: '',
    expect: 'test_setAsset_revertsOnAnyFlagButTheKeepersSwitch',
  },
  {
    id: 'config-asset-range-at-most-double',
    file: CONFIG,
    find: 'cfg.maxPrice <= 2 * uint256(cfg.minPrice),',
    replace: 'true,',
    expect: 'test_setAsset_revertsOnARangeThatIsNotOne',
  },
  {
    id: 'config-asset-range-ceiling-above-floor',
    file: CONFIG,
    find: 'cfg.maxPrice > cfg.minPrice && ',
    replace: '',
    expect: 'test_setAsset_revertsOnARangeThatIsNotOne',
  },
  {
    id: 'config-switch-needs-chainlink',
    file: CONFIG,
    find: 'cfg.source == 1 && cfg.averageFeed',
    replace: 'cfg.averageFeed',
    expect: 'test_setAsset_theKeepersSwitch_needsAFeedAnAverageAndARange',
  },
  {
    id: 'config-switch-needs-an-average',
    file: CONFIG,
    find: 'cfg.averageFeed != address(0) && ',
    replace: '',
    expect: 'test_setAsset_theKeepersSwitch_needsAFeedAnAverageAndARange',
  },
  {
    id: 'config-switch-average-apart',
    file: CONFIG,
    find: 'cfg.averageFeed != cfg.feed && ',
    replace: '',
    expect: 'test_setAsset_theKeepersSwitch_needsAFeedAnAverageAndARange',
  },
  {
    id: 'config-switch-needs-a-range',
    file: CONFIG,
    find: 'cfg.averageFeed != cfg.feed && ranged,',
    replace: 'cfg.averageFeed != cfg.feed,',
    expect: 'test_setAsset_theKeepersSwitch_needsAFeedAnAverageAndARange',
  },
  {
    id: 'config-params-band',
    file: CONFIG,
    find: 'require(p.bandBps <= MAX_BAND_BPS, ParamOutOfBounds("bandBps", p.bandBps));',
    replace: '',
    expect: 'test_setParams_revertsOnBandAbove500',
  },
  {
    id: 'config-params-cooldown-at-most-a-week',
    file: CONFIG,
    find: 'require(p.assetCooldown <= MAX_ASSET_COOLDOWN, ParamOutOfBounds("assetCooldown", p.assetCooldown));',
    replace: '',
    expect: 'test_setParams_revertsOnCooldownAboveSevenDays',
  },
  {
    id: 'config-price-deviation-bound',
    file: CONFIG,
    find: 'require(bps <= MAX_PRICE_DEV_BPS, ParamOutOfBounds("priceDevBps", bps));',
    replace: '',
    expect: 'test_setPriceDevBps_storesItUpTo1000',
  },
  {
    id: 'config-admin-setPriceDevBps',
    file: CONFIG,
    ...admin('function setPriceDevBps(uint16 bps)'),
    expect: 'test_setPriceDevBps_revertsForNonAdmin',
  },
  // ---- the test network's own contracts (TNET-1)
  {
    id: 'testnet-token-mint-role',
    file: TEST_TOKEN,
    find: 'function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {',
    replace: 'function mint(address to, uint256 amount) external {',
    expect: 'test_cash_hasItsDecimals_andOnlyAMinterMints',
  },
  {
    id: 'testnet-token-burn-role',
    file: TEST_TOKEN,
    find: 'function burn(address from, uint256 amount) external onlyRole(MINTER_ROLE) {',
    replace: 'function burn(address from, uint256 amount) external {',
    expect: 'test_cash_onlyAMinterBurns',
  },
  {
    id: 'testnet-stock-pause-role',
    file: TEST_STOCK,
    find: 'function pause() external onlyRole(ISSUER_ROLE) {',
    replace: 'function pause() external {',
    expect: 'test_stock_onlyTheIssuerPausesAndSetsTheMultiplier',
  },
  {
    id: 'testnet-stock-unpause-role',
    file: TEST_STOCK,
    find: 'function unpause() external onlyRole(ISSUER_ROLE) {',
    replace: 'function unpause() external {',
    expect: 'test_stock_onlyTheIssuerPausesAndSetsTheMultiplier',
  },
  {
    id: 'testnet-stock-multiplier-now-role',
    file: TEST_STOCK,
    find: 'function updateMultiplier(uint256 newMultiplier) external onlyRole(ISSUER_ROLE) {',
    replace: 'function updateMultiplier(uint256 newMultiplier) external {',
    expect: 'test_stock_onlyTheIssuerPausesAndSetsTheMultiplier',
  },
  {
    id: 'testnet-stock-multiplier-later-role',
    file: TEST_STOCK,
    find: 'function updateMultiplier(uint256 newMultiplier, uint256 effectiveAt_) external onlyRole(ISSUER_ROLE) {',
    replace: 'function updateMultiplier(uint256 newMultiplier, uint256 effectiveAt_) external {',
    expect: 'test_stock_onlyTheIssuerPausesAndSetsTheMultiplier',
  },
  {
    id: 'testnet-stock-paused-moves-nothing',
    file: TEST_STOCK,
    find: 'require(!_paused, TokenPaused());',
    replace: '',
    expect: 'test_stock_paused_movesNothing',
  },
  {
    id: 'testnet-stock-paused-vault-skips',
    file: TEST_STOCK,
    find: 'require(!_paused, TokenPaused());',
    replace: '',
    expect: 'test_issuerPause_stopsTheKeeper_andTheOwnerTakesTheRest',
  },
  {
    id: 'testnet-stock-multiplier-at-its-time',
    file: TEST_STOCK,
    find: 'return block.timestamp >= _effectiveAt ? _newMultiplier : _multiplier;',
    replace: 'return _newMultiplier;',
    expect: 'test_stock_aScheduledMultiplier_takesEffectAtItsTime',
  },
  {
    id: 'testnet-stock-multiplier-from-current',
    file: TEST_STOCK,
    find: 'uint256 current = uiMultiplier();',
    replace: 'uint256 current = _newMultiplier;',
    expect: 'test_stock_aSecondScheduleReplacesTheFirst',
  },
  {
    id: 'testnet-stock-multiplier-not-zero',
    file: TEST_STOCK,
    find: 'require(newMultiplier != 0, ZeroMultiplier());',
    replace: '',
    expect: 'test_stock_aMultiplierOfZero_orInThePast_isRefused',
  },
  {
    id: 'testnet-stock-multiplier-not-past',
    file: TEST_STOCK,
    find: 'require(effectiveAt_ >= block.timestamp, EffectiveInThePast(effectiveAt_, block.timestamp));',
    replace: '',
    expect: 'test_stock_aMultiplierOfZero_orInThePast_isRefused',
  },
  {
    id: 'testnet-stock-schedule-read-by-vault',
    file: TEST_STOCK,
    find: '_effectiveAt = effectiveAt_;',
    replace: '',
    expect: 'test_multiplierWindow_aroundTheTestTokensChange',
  },
  {
    id: 'testnet-feed-writer',
    file: TEST_FEED,
    find: 'require(msg.sender == writer || msg.sender == owner(), NotWriter(msg.sender));',
    replace: '',
    expect: 'test_feed_onlyTheWriterOrTheOwnerWrites',
  },
  {
    id: 'testnet-feed-setWriter-owner',
    file: TEST_FEED,
    find: 'function setWriter(address writer_) external onlyOwner {',
    replace: 'function setWriter(address writer_) external {',
    expect: 'test_feed_theOwnerReplacesTheWriter',
  },
  {
    id: 'testnet-feed-positive',
    file: TEST_FEED,
    find: 'require(answer > 0, AnswerNotPositive(answer));',
    replace: '',
    expect: 'test_feed_anAnswerOfZeroOrBelow_isRefused',
  },
  {
    id: 'testnet-feed-newer',
    file: TEST_FEED,
    find: 'require(updatedAt > latest, NotNewer(updatedAt, latest));',
    replace: '',
    expect: 'test_feed_aTimeNotNewer_isRefused',
  },
  {
    id: 'testnet-feed-ahead',
    file: TEST_FEED,
    find: 'require(updatedAt <= block.timestamp + MAX_AHEAD, StampedAhead(updatedAt, block.timestamp));',
    replace: '',
    expect: 'test_feed_aTimeTooFarAhead_isRefused',
  },
  {
    id: 'testnet-feed-no-data',
    file: TEST_FEED,
    find: 'require(r.updatedAt != 0, NoDataPresent());',
    replace: '',
    expect: 'test_feed_beforeTheFirstRound_reverts',
  },
  {
    id: 'testnet-feed-stamp-read-by-vault',
    file: TEST_FEED,
    find: 'return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);',
    replace: 'return (roundId, r.answer, r.updatedAt, block.timestamp, roundId);',
    expect: 'test_keeper_aStalePrice_isRefused',
  },
  {
    id: 'testnet-sequencer-owner',
    file: TEST_SEQUENCER,
    find: 'function setDown(bool down_) external onlyOwner {',
    replace: 'function setDown(bool down_) external {',
    expect: 'test_sequencer_onlyTheOwnerFlipsIt',
  },
  {
    id: 'testnet-sequencer-not-ahead',
    file: TEST_SEQUENCER,
    find: 'require(since <= block.timestamp, ChangedInTheFuture(since, block.timestamp));',
    replace: '',
    expect: 'test_sequencer_aTimeAhead_isRefused',
  },
  {
    id: 'testnet-sequencer-time-of-change',
    file: TEST_SEQUENCER,
    find: '        changedAt = uint64(block.timestamp);\n',
    replace: '',
    expect: 'test_sequencerStub_justUp_thenAnHourLater_thenDown',
  },
  {
    id: 'testnet-market-recentre-who',
    file: TEST_MARKET,
    find: 'require(msg.sender == operator || msg.sender == owner(), NotOperator(msg.sender));',
    replace: '',
    expect: 'test_market_onlyTheOwnerOrTheWriterRecentres',
  },
  {
    id: 'testnet-market-open-owner',
    file: TEST_MARKET,
    find: 'function open(address token) external onlyOwner {',
    replace: 'function open(address token) external {',
    expect: 'test_market_onlyTheOwnerOpensSeedsAndSetsFeeds',
  },
  {
    id: 'testnet-market-seed-owner',
    file: TEST_MARKET,
    find: 'function seed(address token, uint256 cashPerSide) external onlyOwner returns (uint128 liquidity) {',
    replace:
      'function seed(address token, uint256 cashPerSide) external returns (uint128 liquidity) {',
    expect: 'test_market_onlyTheOwnerOpensSeedsAndSetsFeeds',
  },
  {
    id: 'testnet-market-setFeed-owner',
    file: TEST_MARKET,
    find: 'function setFeed(address token, address feed) external onlyOwner {',
    replace: 'function setFeed(address token, address feed) external {',
    expect: 'test_market_onlyTheOwnerOpensSeedsAndSetsFeeds',
  },
  {
    id: 'testnet-market-setOperator-owner',
    file: TEST_MARKET,
    find: 'function setOperator(address operator_) external onlyOwner {',
    replace: 'function setOperator(address operator_) external {',
    expect: 'test_market_onlyTheOwnerOpensSeedsAndSetsFeeds',
  },
  {
    id: 'testnet-market-callback-pool-manager',
    file: TEST_MARKET,
    find: 'require(msg.sender == address(poolManager), NotPoolManager(msg.sender));',
    replace: '',
    expect: 'test_market_onlyThePoolManagerCallsBack',
  },
  {
    id: 'testnet-market-open-elsewhere',
    file: TEST_MARKET,
    find: 'require(_apartBps(current, target) <= driftBps, PoolOpenElsewhere(token, current, target));',
    replace: '',
    expect: 'test_market_aPoolOpenedElsewhere_isRefused',
  },
  {
    id: 'testnet-market-leaves-a-pool-at-its-price',
    file: TEST_MARKET,
    find: 'if (_apartBps(current, target) <= driftBps) return false;',
    replace: '',
    expect: 'test_market_recentresToTheTestPrice',
  },
  {
    id: 'testnet-market-burns-what-it-takes',
    file: TEST_MARKET,
    find: 'ITestTokenSupply(currency).burn(address(this), uint256(uint128(amount)));',
    replace: '',
    expect: 'test_market_holdsNothing',
  },
  {
    id: 'testnet-market-no-feed',
    file: TEST_MARKET,
    find: 'require(feed != address(0), NoFeed(token));',
    replace: '',
    expect: 'test_market_aTokenWithoutAFeed_hasNoPrice',
  },
  {
    id: 'testnet-market-pair-side',
    file: TEST_MARKET,
    find: 'token < cash ? (uint256(answer) * cashUnit, one * tokenUnit)',
    replace: 'true ? (uint256(answer) * cashUnit, one * tokenUnit)',
    expect: 'test_kit_eachPoolOpensAtItsTestPrice',
  },
  {
    id: 'testnet-market-recentre-follows-the-copy',
    file: TEST_MARKET,
    find: 'poolManager.unlock(abi.encode(ACTION_SWAP, token, uint256(target)));',
    replace: '',
    expect: 'test_vault_aPoolFarFromItsTestPrice_isRefusedForTheKeeper',
  },
  {
    id: 'testnet-kit-chain',
    file: KIT,
    find: 'require(cfg.chainId == block.chainid, WrongChain(cfg.chainId, block.chainid));',
    replace: '',
    expect: 'test_kit_refusesTheDeployerAsWriter_andNoWriter',
  },
  {
    id: 'testnet-kit-writer-not-deployer',
    file: KIT,
    find: 'require(cfg.priceWriter != deployer, WriterIsDeployer(cfg.priceWriter));',
    replace: '',
    expect: 'test_kit_refusesTheDeployerAsWriter_andNoWriter',
  },
  {
    id: 'testnet-kit-rerun-finds-each-contract',
    file: KIT,
    find: 'if (addr.code.length != 0) return addr;',
    replace: '',
    expect: 'test_kit_deploysEverything_andASecondRunSendsNothing',
  },
  {
    id: 'testnet-kit-rerun-seeds-nothing',
    file: KIT,
    find: 'if (market.poolLiquidity(l.token) == 0) {',
    replace: 'if (true) {',
    expect: 'test_kit_deploysEverything_andASecondRunSendsNothing',
  },
  {
    id: 'testnet-kit-rerun-writes-no-round',
    file: KIT,
    find: 'if (feed.latestRound() == 0) {',
    replace: 'if (true) {',
    expect: 'test_kit_deploysEverything_andASecondRunSendsNothing',
  },
  {
    id: 'testnet-copier-newer-price-only',
    file: COPIER,
    find: 'bool newerPrice = reading.updatedAt > heldPriceAt;',
    replace: 'bool newerPrice = true;',
    expect: 'test_copier_writesWhatIsNewer_andASecondRoundNothing',
  },
  {
    id: 'testnet-copier-average-only-while-it-moves',
    file: COPIER,
    find: 'reading.averageAt >= heldAverageAt + AVERAGE_EVERY && reading.average != heldAverage',
    replace: 'reading.averageAt >= heldAverageAt + AVERAGE_EVERY',
    expect: 'test_copier_theAverageAtMostEveryFiveMinutes_andOnlyWhileItMoves',
  },
  {
    id: 'testnet-copier-average-every-five-minutes',
    file: COPIER,
    find: 'reading.averageAt >= heldAverageAt + AVERAGE_EVERY && reading.average != heldAverage',
    replace: 'reading.average != heldAverage',
    expect: 'test_copier_theAverageAtMostEveryFiveMinutes_andOnlyWhileItMoves',
  },
  {
    id: 'testnet-copier-jump',
    file: COPIER,
    find: 'if (move * 10_000 > before * allowed) {',
    replace: 'if (false) {',
    expect: 'test_copier_aJump_isRefused_andWidensWithTheGap',
  },
  {
    id: 'testnet-copier-jump-cap',
    file: COPIER,
    find: 'if (allowed > MAX_GAP_JUMP_BPS) allowed = MAX_GAP_JUMP_BPS;',
    replace: '',
    expect: 'test_copier_aJump_isRefused_andWidensWithTheGap',
  },
  {
    id: 'testnet-copier-range',
    file: COPIER,
    find: 'if (max != 0 && (v < min || v > max)) {',
    replace: 'if (false) {',
    expect: 'test_copier_outsideTheVaultsRange_isRefused',
  },
  {
    id: 'testnet-copier-ahead',
    file: COPIER,
    find: 'if (stamp > block.timestamp + MAX_AHEAD) {',
    replace: 'if (false) {',
    expect: 'test_copier_aValueNotAboveZeroOrStampedAhead_isRefused',
  },
  {
    id: 'testnet-copier-positive',
    file: COPIER,
    find: 'if (value <= 0) return string.concat(what, " is not above zero");',
    replace: '',
    expect: 'test_copier_aValueNotAboveZeroOrStampedAhead_isRefused',
  },
  {
    id: 'testnet-copier-source-description',
    file: COPIER,
    find: 'if (keccak256(bytes(feed.description())) != keccak256(bytes(a.sourceDescription))) {',
    replace: 'if (false) {',
    expect: 'test_copier_aSourceThatSaysItIsAnotherFeed_isRefused',
  },
  {
    id: 'testnet-copier-average-by-time',
    file: COPIER,
    find: 'sum += uint256(answer) * (upTo - from);',
    replace: 'sum += uint256(answer) * 1800;',
    expect: 'test_copier_averageWeighsEachRoundByTheTimeItHeld',
  },
  {
    id: 'testnet-copier-average-hour',
    file: COPIER,
    find: 'uint256 from = updatedAt > start ? updatedAt : start;',
    replace: 'uint256 from = updatedAt;',
    expect: 'test_copier_averageStopsAtTheHour',
  },
  {
    id: 'testnet-copier-deploy-key',
    file: COPIER,
    find: 'require(signer != r.admin, DeployKey(signer));',
    replace: '',
    expect: 'test_copier_signsOnlyAsThePriceWriter',
  },
  {
    id: 'testnet-copier-writer',
    file: COPIER,
    find: 'require(signer == r.priceWriter, NotTheWriter(signer, r.priceWriter));',
    replace: '',
    expect: 'test_copier_signsOnlyAsThePriceWriter',
  },
  {
    id: 'testnet-copier-recentre-only-off',
    file: COPIER,
    find: 'if (drift <= market.driftBps()) continue;',
    replace: '',
    expect: 'test_copier_recentresThePools',
  },
  {
    id: 'testnet-copier-refused-writes-nothing',
    file: COPIER,
    find: '_refuse(result, a.symbol, why);\n                continue;',
    replace: '_refuse(result, a.symbol, why);',
    expect: 'test_copier_aJump_isRefused_andWidensWithTheGap',
  },
];

// Fewer fuzz and invariant runs than the default: a removed rule fails on the first runs or not at all.
const env = {
  ...process.env,
  FOUNDRY_DISABLE_NIGHTLY_WARNING: '1',
  FOUNDRY_FUZZ_RUNS: '64',
  FOUNDRY_INVARIANT_RUNS: '32',
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valued = ['--jobs', '--from', '--count'];
const option = (name, fallback) => {
  const at = args.indexOf(name);
  const value = at === -1 ? Number.NaN : Number(args[at + 1]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};
const jobs = Math.max(1, option('--jobs', 1));
const filter =
  args.find((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1] ?? '')) ?? '';
const matching = RULES.filter((rule) => rule.id.includes(filter));
const from = option('--from', 0);
const rules = matching.slice(from, from + option('--count', matching.length));

// ---- the check that needs no compiler: each rule's text is in its file once, and its test exists
const sources = new Map();
const source = (file) => {
  if (!sources.has(file)) sources.set(file, readFileSync(join(root, file), 'utf8'));
  return sources.get(file);
};
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
const tests = walk(join(root, 'test'))
  .filter((path) => path.endsWith('.t.sol'))
  .map((path) => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }));
// The file a test is in. Forge is told to build that file alone, which is most of the time a rule takes.
const fileOf = (name) => tests.find((t) => t.text.includes(`function ${name}(`))?.path;
const stale = [];
const ids = new Set();
for (const rule of rules) {
  if (ids.has(rule.id)) stale.push(`${rule.id}: the id is used twice`);
  ids.add(rule.id);
  if (source(rule.file).split(rule.find).length !== 2)
    stale.push(`${rule.id}: the text to remove is not in ${rule.file} exactly once`);
  if (!fileOf(rule.expect)) stale.push(`${rule.id}: no test named ${rule.expect}`);
}
if (stale.length > 0) {
  for (const line of stale) console.log(`STALE   ${line}`);
  console.log(`\n${stale.length} rules are stale.`);
  process.exit(1);
}
// How many rules there are is not how many removals: several rules can take out the same text and name
// different tests that must each catch it.
const removalOf = (rule) => [rule.file, rule.find, rule.replace].join('\u0000');
const removals = new Set(rules.map(removalOf)).size;
const perFile = [...new Set(rules.map((rule) => rule.file))]
  .map(
    (file) =>
      `${file.replace(/^src\/|\.sol$/g, '')} ${rules.filter((r) => r.file === file).length}`,
  )
  .join(', ');
const census = `${rules.length} rules, ${removals} distinct removals (${perFile})`;
if (flag('--check')) {
  console.log(`${census}: each text is in its file once, and each test exists.`);
  process.exit(0);
}

// ---- the copies
const kept = process.env.RULES_BITE_DIR;
if (kept) mkdirSync(kept, { recursive: true });
const work = kept ?? mkdtempSync(join(tmpdir(), 'rules-bite-'));
let children = [];
function cleanUp() {
  for (const child of children) child.kill();
  if (!kept) rmSync(work, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanUp();
    process.exit(130);
  });
}

// A copy has the layout of the repo as far as the project reads it: contracts/ with its sources, and beside
// it the three folders its config points at through `..`. Dependencies and fixtures are links, not copies.
function makeCopy(n, warm) {
  const dir = join(work, `job-${n}`);
  const project = join(dir, 'contracts');
  mkdirSync(project, { recursive: true });
  // In a kept copy the sources are replaced, so a rule left out by a run that was killed is put back.
  for (const name of ['src', 'test', 'script', 'foundry.toml']) {
    rmSync(join(project, name), { recursive: true, force: true });
    cpSync(join(root, name), join(project, name), { recursive: true });
  }
  const links = [
    [join(root, 'node_modules'), join(project, 'node_modules')],
    [join(repo, 'node_modules'), join(dir, 'node_modules')],
    [join(repo, 'fixtures'), join(dir, 'fixtures')],
    [join(repo, 'idl'), join(dir, 'idl')],
  ];
  for (const [target, link] of links) if (!existsSync(link)) symlinkSync(target, link);
  if (warm && !existsSync(join(project, 'cache'))) {
    for (const name of ['out', 'cache']) {
      if (existsSync(join(warm, name)))
        cpSync(join(warm, name), join(project, name), { recursive: true });
    }
  }
  return project;
}

// Run from the project folder: with `--root`, forge writes its failure cache into the caller's folder.
function forgeTest(project, extra = []) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('forge', ['test', ...extra], { cwd: project, env });
    children.push(child);
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (status) => {
      children = children.filter((c) => c !== child);
      const failed = new Set([...out.matchAll(/^\[FAIL.*?\] (\w+)\(/gm)].map((m) => m[1]));
      const passed = new Set([...out.matchAll(/^\[PASS\] (\w+)\(/gm)].map((m) => m[1]));
      const compiled = !/Compiler run failed|^Error: /m.test(out) || failed.size + passed.size > 0;
      resolve({ ok: status === 0, compiled, failed, passed, out });
    });
  });
}

const first = makeCopy(0, null);
const baseline = await forgeTest(first);
if (!baseline.ok) {
  console.error(baseline.out.split('\n').slice(-30).join('\n'));
  console.error('The tests do not pass before any rule is removed. Fix that first.');
  cleanUp();
  process.exit(1);
}
const projects = [first];
for (let n = 1; n < Math.min(jobs, rules.length); n++) projects.push(makeCopy(n, first));

// Rules that take out the same text are judged from one build: the removal is made once and each rule's
// test is looked up in the one run.
const groups = new Map();
for (const [i, rule] of rules.entries()) {
  const key = removalOf(rule);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(i);
}

async function judge(indexes, project) {
  const live = indexes.filter((i) => baseline.passed.has(rules[i].expect));
  const out = new Map(
    indexes
      .filter((i) => !live.includes(i))
      .map((i) => [i, `STALE   ${rules[i].id}: no test named ${rules[i].expect} passes today`]),
  );
  if (live.length === 0) return out;
  const { file, find, replace } = rules[live[0]];
  const names = [...new Set(live.map((i) => rules[i].expect))];
  const files = [...new Set(names.map(fileOf))];
  const path = join(project, file);
  const original = readFileSync(path, 'utf8');
  let result;
  try {
    writeFileSync(path, original.replace(find, replace));
    // Only the tests that should catch it, and only their files: the rest would cost time and say nothing
    // about this rule.
    result = await forgeTest(project, [
      '--match-path',
      files.length === 1 ? files[0] : `{${files.join(',')}}`,
      '--match-test',
      `^(${names.join('|')})\\(`,
    ]);
  } finally {
    writeFileSync(path, original);
  }
  for (const i of live) {
    const { id, expect } = rules[i];
    // The named test itself must fail. A `setUp` that fails with the rule removed shows that something
    // broke, not that this test holds the rule, so it does not count.
    if (!result.compiled) {
      out.set(i, `BROKEN  ${id}: does not compile with the rule removed, so nothing is shown`);
    } else if (result.failed.has(expect)) {
      out.set(i, `bites   ${id}: ${expect} fails`);
    } else if (result.passed.has(expect)) {
      out.set(i, `SILENT  ${id}: ${expect} still passes`);
    } else {
      out.set(i, `SILENT  ${id}: ${expect} did not run (its setUp fails with the rule removed)`);
    }
  }
  return out;
}

const verdicts = new Array(rules.length);
const queue = [...groups.values()];
await Promise.all(
  projects.map(async (project) => {
    while (queue.length > 0) {
      for (const [i, verdict] of await judge(queue.shift(), project)) {
        verdicts[i] = verdict;
        console.log(verdict);
      }
    }
  }),
);
cleanUp();

const bit = verdicts.filter((v) => v.startsWith('bites')).length;
const wrong = verdicts.filter((v) => /^(SILENT|BROKEN|STALE)/.test(v));
const span =
  rules.length === RULES.length
    ? ''
    : ` (rules ${from} to ${from + rules.length - 1} of ${matching.length})`;
console.log(`\n${bit} of ${rules.length} rules bite${span}. ${census}.`);
if (wrong.length > 0) {
  console.log('Not shown:');
  for (const line of wrong) console.log(`  ${line}`);
}
process.exit(wrong.length === 0 ? 0 : 1);
