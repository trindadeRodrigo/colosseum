#!/usr/bin/env node
// Shows that each rule in the contracts bites: takes one check out at a time, runs the test that should
// catch it, and expects that test to fail.
//
//   node contracts/script/rules-bite.mjs                every rule
//   node contracts/script/rules-bite.mjs swap           only the rules whose id contains "swap"
//   node contracts/script/rules-bite.mjs --jobs 4       four at a time (the default is 3)
//   node contracts/script/rules-bite.mjs --check        only that each rule's text and test still exist
//
// It never edits the checkout. It works on copies of the project in a temporary folder (under TMPDIR), one
// per job, each with its own build cache, and removes them at the end. So it can run while the sources are
// being edited, and the copies are of the files as they are on disk when it starts.
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..');
const VAULT = 'src/BasketVault.sol';
const CONFIG = 'src/VaultConfig.sol';
const FACTORY = 'src/VaultFactory.sol';
const REGISTRY = 'src/IndexRegistry.sol';
const BEACON = 'src/VaultBeacon.sol';

const WITHDRAW =
  'function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {';
const WITHDRAW_ALL = 'function withdrawAll() external onlyOwner nonReentrant returns';
const DEPOSIT = 'function deposit(uint256 amount) external onlyOwner nonReentrant {';
const OWNER_SWAP = 'function ownerSwap(Swap[] calldata swaps) external onlyOwner nonReentrant {';
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
const ROUTER_OK =
  's.router != address(this) && s.router != PERMIT2 && !$.tokens.contains(s.router),';
const RECEIVED =
  'require(received >= s.minOut, IBasketVault.ReceivedTooLittle(token, received, s.minOut));';
const TOKEN_RESET = 'IERC20(token).forceApprove(spender, 0);';
const PERMIT2_RESET = 'IPermit2(PERMIT2).approve(token, router, 0, 0);';
const VIEWS = '    // ---- views\n';
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
    replace: ROUTER_OK.replace('s.router != address(this) && ', ''),
    expect: 'test_hostile_permit2OrTheVaultAsRouter_isRefusedTwice',
  },
  {
    id: 'vault-swap-router-is-not-permit2',
    file: VAULT,
    find: ROUTER_OK,
    replace: ROUTER_OK.replace('s.router != PERMIT2 && ', ''),
    expect: 'test_hostile_permit2OrTheVaultAsRouter_isRefusedTwice',
  },
  {
    id: 'vault-swap-router-is-not-a-held-token',
    file: VAULT,
    find: ROUTER_OK,
    replace: ROUTER_OK.replace(' && !$.tokens.contains(s.router)', ''),
    expect: 'test_hostile_approveAsItsSwap_isRefusedTwice',
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
    id: 'vault-swap-traded-tokens-readable',
    file: VAULT,
    find: 'require(!traded || (was != UNREADABLE && left != UNREADABLE), IBasketVault.BalanceUnreadable(token));',
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
    find: VIEWS,
    replace: `    function multicall(bytes[] calldata data) public override nonReentrant returns (bytes[] memory) {\n        return super.multicall(data);\n    }\n\n${VIEWS}`,
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
  {
    id: 'factory-init-once',
    file: FACTORY,
    find: 'Params calldata params_) external initializer {',
    replace: 'Params calldata params_) external {',
    expect: 'test_A15_initialize_revertsOnTheLogicContractAndOnTheLiveProxy',
  },
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
    id: 'factory-no-auto-follow-yet',
    file: FACTORY,
    find: 'require(!autoFollow, AutoFollowUnavailable());',
    replace: '',
    expect: 'test_createVault_refusesAutoFollow',
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
const jobsAt = args.indexOf('--jobs');
const jobs = Math.max(1, jobsAt === -1 ? 3 : Number(args[jobsAt + 1]) || 3);
const filter =
  args.find((a, i) => !a.startsWith('--') && (jobsAt === -1 || i !== jobsAt + 1)) ?? '';
const rules = RULES.filter((rule) => rule.id.includes(filter));

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
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
const stale = [];
const ids = new Set();
for (const rule of rules) {
  if (ids.has(rule.id)) stale.push(`${rule.id}: the id is used twice`);
  ids.add(rule.id);
  if (source(rule.file).split(rule.find).length !== 2)
    stale.push(`${rule.id}: the text to remove is not in ${rule.file} exactly once`);
  if (!tests.includes(`function ${rule.expect}(`))
    stale.push(`${rule.id}: no test named ${rule.expect}`);
}
if (stale.length > 0) {
  for (const line of stale) console.log(`STALE   ${line}`);
  console.log(`\n${stale.length} rules are stale.`);
  process.exit(1);
}
if (flag('--check')) {
  console.log(`${rules.length} rules: each text is in its file once, and each test exists.`);
  process.exit(0);
}

// ---- the copies
const work = mkdtempSync(join(tmpdir(), 'rules-bite-'));
let children = [];
function cleanUp() {
  for (const child of children) child.kill();
  rmSync(work, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanUp();
    process.exit(130);
  });
}

// A copy has the layout of the repo as far as the project reads it: contracts/ with its sources, and beside
// it the two folders its config points at through `..`. Dependencies and fixtures are links, not copies.
function makeCopy(n, from) {
  const dir = join(work, `job-${n}`);
  const project = join(dir, 'contracts');
  mkdirSync(project, { recursive: true });
  for (const name of ['src', 'test', 'script', 'foundry.toml']) {
    cpSync(join(root, name), join(project, name), { recursive: true });
  }
  symlinkSync(join(root, 'node_modules'), join(project, 'node_modules'));
  symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'));
  symlinkSync(join(repo, 'fixtures'), join(dir, 'fixtures'));
  if (from) {
    for (const name of ['out', 'cache']) {
      if (existsSync(join(from, name)))
        cpSync(join(from, name), join(project, name), { recursive: true });
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

async function judge(rule, project) {
  if (!baseline.passed.has(rule.expect)) {
    return `STALE   ${rule.id}: no test named ${rule.expect} passes today`;
  }
  const path = join(project, rule.file);
  const original = readFileSync(path, 'utf8');
  let result;
  try {
    writeFileSync(path, original.replace(rule.find, rule.replace));
    // Only the test that should catch it: the rest would cost time and say nothing about this rule.
    result = await forgeTest(project, ['--match-test', `^${rule.expect}\\(`]);
  } finally {
    writeFileSync(path, original);
  }
  if (!result.compiled) {
    return `BROKEN  ${rule.id}: does not compile with the rule removed, so nothing is shown`;
  }
  const bites =
    result.failed.has(rule.expect) ||
    (result.failed.has('setUp') && !result.passed.has(rule.expect));
  return bites
    ? `bites   ${rule.id}: ${rule.expect} fails`
    : `SILENT  ${rule.id}: ${rule.expect} still passes`;
}

const verdicts = new Array(rules.length);
let next = 0;
await Promise.all(
  projects.map(async (project) => {
    while (next < rules.length) {
      const i = next++;
      verdicts[i] = await judge(rules[i], project);
      console.log(verdicts[i]);
    }
  }),
);
cleanUp();

const bit = verdicts.filter((v) => v.startsWith('bites')).length;
const wrong = verdicts.filter((v) => /^(SILENT|BROKEN|STALE)/.test(v));
console.log(`\n${bit} of ${rules.length} rules bite.`);
if (wrong.length > 0) {
  console.log('Not shown:');
  for (const line of wrong) console.log(`  ${line}`);
}
process.exit(wrong.length === 0 ? 0 : 1);
