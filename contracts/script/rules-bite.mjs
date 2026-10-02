#!/usr/bin/env node
// Shows that each rule in the contracts bites: takes one check out at a time, runs the test that should
// catch it, and expects that test to fail.
//
//   node contracts/script/rules-bite.mjs          every rule
//   node contracts/script/rules-bite.mjs sweep    only the rules whose id contains "sweep"
//
// It edits files under contracts/src while it runs. Each file is put back after its rule, and on Ctrl-C,
// SIGTERM or SIGHUP. It refuses to start if contracts/src has uncommitted changes, so that whatever
// happens `git checkout contracts/src` brings back exactly what was there.
//
// Foundry 1.8 has `forge test --mutate` for this; the toolchain on this machine is older.
// A rule added to the contracts gets a line here in the same pull request.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VAULT = 'src/BasketVault.sol';
const CONFIG = 'src/VaultConfig.sol';

const WITHDRAW =
  'function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {';
const WITHDRAW_ALL = 'function withdrawAll() external onlyOwner nonReentrant returns';
const DEPOSIT = 'function deposit(uint256 amount) external onlyOwner nonReentrant {';
const INIT_ZERO =
  'require(owner_ != address(0) && config_ != address(0), IBasketVault.ZeroAddress());';
const PAY_OWNER = 'IERC20(token).safeTransfer(_vault().owner, amount);';
const VIEWS = '    // ---- views\n';

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
    id: 'vault-owner-check-itself',
    file: VAULT,
    find: 'require(msg.sender == _vault().owner, IBasketVault.NotOwner(msg.sender));',
    replace: '',
    expect: 'invariant_I1_tokensLeaveOnlyByTheOwnerAndToTheOwner',
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
  // ---- the vault: initialise
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
    find: 'address config_) external initializer {',
    replace: 'address config_) external {',
    expect: 'test_A15_initialize_revertsOnLiveProxy',
  },
  {
    id: 'vault-init-zero-owner',
    file: VAULT,
    find: INIT_ZERO,
    replace: 'require(config_ != address(0), IBasketVault.ZeroAddress());',
    expect: 'test_initialize_revertsOnZeroOwner',
  },
  {
    id: 'vault-init-zero-config',
    file: VAULT,
    find: INIT_ZERO,
    replace: 'require(owner_ != address(0), IBasketVault.ZeroAddress());',
    expect: 'test_initialize_revertsOnZeroConfig',
  },
  // ---- the vault: deposit
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
    find: 'require(received >= amount, IBasketVault.DepositShortfall(cash, amount, received));',
    replace: '',
    expect: 'test_deposit_feeOnTransferCash_isRejected',
  },
  {
    id: 'vault-deposit-false-return',
    file: VAULT,
    find: 'IERC20(cash).safeTransferFrom(msg.sender, address(this), amount);',
    replace: 'cash.call(abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount)));',
    expect: 'test_deposit_cashTokenReturningFalse',
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
  // ---- the vault: one reentrancy guard
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
    find: 'function setRouter(address router, uint8 pull) external onlyAdmin {',
    replace: 'function setRouter(address router, uint8 pull) external {',
    expect: 'test_setRouter_revertsForNonAdmin',
  },
  {
    id: 'config-admin-setCashToken',
    file: CONFIG,
    find: 'function setCashToken(address token) external onlyAdmin {',
    replace: 'function setCashToken(address token) external {',
    expect: 'test_setCashToken_revertsForNonAdmin',
  },
  {
    id: 'config-admin-proposeAdmin',
    file: CONFIG,
    find: 'function proposeAdmin(address next) external onlyAdmin {',
    replace: 'function proposeAdmin(address next) external {',
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
  // ---- the config: routers and the cash token
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
    find: 'require(!$.assetList.contains(router), RouterIsAsset(router));',
    replace: '',
    expect: 'test_setRouter_revertsOnAListedAsset',
  },
  {
    id: 'config-router-removal-always-works',
    file: CONFIG,
    find: 'if (pull != 0) {',
    replace: '{',
    expect: 'test_setRouter_removesARouterWhoseCodeIsGone',
  },
  {
    id: 'config-cash-is-listed',
    file: CONFIG,
    find: 'require($.assetList.contains(token), AssetNotListed(token));',
    replace: '',
    expect: 'test_setCashToken_revertsOnAnythingNotListed',
  },
];

// Fewer fuzz and invariant runs than the default: a removed rule fails on the first runs or not at all.
const env = {
  ...process.env,
  FOUNDRY_DISABLE_NIGHTLY_WARNING: '1',
  FOUNDRY_FUZZ_RUNS: '64',
  FOUNDRY_INVARIANT_RUNS: '32',
};

const originals = new Map();
let child = null;
function restore() {
  for (const [path, text] of originals) writeFileSync(path, text);
  originals.clear();
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    child?.kill();
    restore();
    process.exit(130);
  });
}

// Run from the project folder: with `--root`, forge writes its failure cache into the caller's folder.
function forgeTest(args = []) {
  return new Promise((resolve) => {
    let out = '';
    child = spawn('forge', ['test', ...args], { cwd: root, env });
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('close', (status) => {
      child = null;
      const failed = new Set([...out.matchAll(/^\[FAIL.*?\] (\w+)\(/gm)].map((m) => m[1]));
      const passed = new Set([...out.matchAll(/^\[PASS\] (\w+)\(/gm)].map((m) => m[1]));
      const compiled = !/Compiler run failed|^Error: /m.test(out) || failed.size + passed.size > 0;
      resolve({ ok: status === 0, compiled, failed, passed, out });
    });
  });
}

const dirty = spawnSync('git', ['status', '--porcelain', '--', 'src'], {
  cwd: root,
  encoding: 'utf8',
});
if (dirty.status !== 0 || dirty.stdout.trim() !== '') {
  console.error(
    'contracts/src has uncommitted changes (or git could not tell). Commit them first:',
  );
  console.error(dirty.stdout || dirty.stderr);
  process.exit(1);
}

const filter = process.argv[2] ?? '';
const rules = RULES.filter((rule) => rule.id.includes(filter));

const baseline = await forgeTest();
if (!baseline.ok) {
  console.error(baseline.out.split('\n').slice(-30).join('\n'));
  console.error('The tests do not pass before any rule is removed. Fix that first.');
  process.exit(1);
}

let survivors = 0;
for (const rule of rules) {
  const path = join(root, rule.file);
  const source = readFileSync(path, 'utf8');
  if (!baseline.passed.has(rule.expect)) {
    console.log(`STALE   ${rule.id}: no test named ${rule.expect} passes today`);
    survivors++;
    continue;
  }
  if (source.split(rule.find).length !== 2) {
    console.log(`STALE   ${rule.id}: the text to remove is not in ${rule.file} exactly once`);
    survivors++;
    continue;
  }
  originals.set(path, source);
  let result;
  try {
    writeFileSync(path, source.replace(rule.find, rule.replace));
    // Only the test that should catch it: the rest would cost time and say nothing about this rule.
    result = await forgeTest(['--match-test', `^${rule.expect}\\(`]);
  } finally {
    restore();
  }
  if (!result.compiled) {
    console.log(`BROKEN  ${rule.id}: does not compile with the rule removed, so nothing is shown`);
    survivors++;
  } else if (
    result.failed.has(rule.expect) ||
    (result.failed.has('setUp') && !result.passed.has(rule.expect))
  ) {
    console.log(`bites   ${rule.id}: ${rule.expect} fails`);
  } else {
    console.log(`SILENT  ${rule.id}: ${rule.expect} still passes`);
    survivors++;
  }
}

console.log(`\n${rules.length - survivors} of ${rules.length} rules bite.`);
process.exit(survivors === 0 ? 0 : 1);
