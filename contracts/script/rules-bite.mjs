#!/usr/bin/env node
// Shows that each rule in the contracts bites: takes one check out at a time, runs the Foundry tests and
// expects the named test to fail. Every source file is put back afterwards, also on Ctrl-C.
//
//   node contracts/script/rules-bite.mjs          every rule
//   node contracts/script/rules-bite.mjs owner    only the rules whose id contains "owner"
//
// Foundry 1.8 has `forge test --mutate` for this; the pinned toolchain on this machine is older.
// A rule added to the contracts gets a line here in the same pull request.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VAULT = 'src/BasketVault.sol';
const CONFIG = 'src/VaultConfig.sol';

// find: text that occurs exactly once in the file. replace: the same code with the rule taken out.
// expect: a test that must fail without the rule.
const RULES = [
  {
    id: 'vault-owner-withdraw',
    file: VAULT,
    find: 'function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {',
    replace: 'function withdraw(address token, uint256 amount) external nonReentrant {',
    expect: 'test_I1_withdraw_revertsForAnyoneButTheOwner',
  },
  {
    id: 'vault-owner-withdrawAll',
    file: VAULT,
    find: 'function withdrawAll() external onlyOwner nonReentrant returns',
    replace: 'function withdrawAll() external nonReentrant returns',
    expect: 'test_I1_withdraw_revertsForAnyoneButTheOwner',
  },
  {
    id: 'vault-owner-deposit',
    file: VAULT,
    find: 'function deposit(address token, uint256 amount) external onlyOwner nonReentrant {',
    replace: 'function deposit(address token, uint256 amount) external nonReentrant {',
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
    id: 'vault-pays-stored-owner',
    file: VAULT,
    find: 'IERC20(token).safeTransfer(_vault().owner, amount);',
    replace: 'IERC20(token).safeTransfer(address(0xdead), amount);',
    expect: 'test_withdraw_paysTheOwner',
  },
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
    find: 'require(owner_ != address(0) && config_ != address(0), IBasketVault.ZeroAddress());',
    replace: 'require(config_ != address(0), IBasketVault.ZeroAddress());',
    expect: 'test_initialize_revertsOnZeroOwner',
  },
  {
    id: 'vault-init-zero-config',
    file: VAULT,
    find: 'require(owner_ != address(0) && config_ != address(0), IBasketVault.ZeroAddress());',
    replace: 'require(owner_ != address(0), IBasketVault.ZeroAddress());',
    expect: 'test_initialize_revertsOnZeroConfig',
  },
  {
    id: 'vault-deposit-listed-only',
    file: VAULT,
    find: 'require($.config.isAsset(token), IBasketVault.AssetNotListed(token));',
    replace: '',
    expect: 'test_deposit_revertsForUnlistedToken',
  },
  {
    id: 'vault-deposit-shortfall',
    file: VAULT,
    find: 'require(received >= amount, IBasketVault.DepositShortfall(token, amount, received));',
    replace: '',
    expect: 'test_deposit_feeOnTransferToken_isRejected',
  },
  {
    id: 'vault-deposit-false-return',
    file: VAULT,
    find: 'IERC20(token).safeTransferFrom(msg.sender, address(this), amount);',
    replace:
      'token.call(abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), amount)));',
    expect: 'test_deposit_tokenReturningFalse',
  },
  {
    id: 'vault-withdraw-false-return',
    file: VAULT,
    find: 'IERC20(token).safeTransfer(_vault().owner, amount);',
    replace: 'token.call(abi.encodeCall(IERC20.transfer, (_vault().owner, amount)));',
    expect: 'test_withdraw_tokenReturningFalse',
  },
  {
    id: 'vault-withdrawAll-skips-frozen',
    file: VAULT,
    find: 'if (!readable || !IERC20(list[i]).trySafeTransfer(to, held)) skipped[n++] = list[i];',
    replace: 'IERC20(list[i]).safeTransfer(to, held);',
    expect: 'test_A9_frozenToken_doesNotBlockTheOthers',
  },
  {
    id: 'vault-withdrawAll-skips-unreadable',
    file: VAULT,
    find: '(bool readable, uint256 held) = _tryBalanceOf(list[i]);',
    replace: '(bool readable, uint256 held) = (true, IERC20(list[i]).balanceOf(address(this)));',
    expect: 'test_A9_tokenWhoseBalanceReadReverts_isSkipped',
  },
  {
    id: 'vault-reentrancy-withdraw',
    file: VAULT,
    find: 'function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {',
    replace: 'function withdraw(address token, uint256 amount) external onlyOwner {',
    expect: 'test_reentrantCall_isRefused',
  },
  {
    id: 'vault-reentrancy-withdrawAll',
    file: VAULT,
    find: 'function withdrawAll() external onlyOwner nonReentrant returns',
    replace: 'function withdrawAll() external onlyOwner returns',
    expect: 'test_reentrantCall_isRefused',
  },
  {
    id: 'vault-reentrancy-deposit',
    file: VAULT,
    find: 'function deposit(address token, uint256 amount) external onlyOwner nonReentrant {',
    replace: 'function deposit(address token, uint256 amount) external onlyOwner {',
    expect: 'test_reentrantCall_isRefused',
  },
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
    id: 'config-init-zero-admin',
    file: CONFIG,
    find: 'require(admin_ != address(0), ZeroAddress());',
    replace: '',
    expect: 'test_init_revertsOnZeroAdmin',
  },
  {
    id: 'config-asset-zero-token',
    file: CONFIG,
    find: 'require(token != address(0), ZeroAddress());',
    replace: '',
    expect: 'test_setAsset_revertsOnZeroToken',
  },
  {
    id: 'config-asset-feed-required',
    file: CONFIG,
    find: 'require(cfg.source == 0 || cfg.feed != address(0), FeedRequired(token));',
    replace: '',
    expect: 'test_setAsset_revertsWhenAPricedAssetHasNoFeed',
  },
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
];

// Fewer fuzz and invariant runs than the default: a removed rule fails on the first runs or not at all.
const env = {
  ...process.env,
  FOUNDRY_DISABLE_NIGHTLY_WARNING: '1',
  FOUNDRY_FUZZ_RUNS: '64',
  FOUNDRY_INVARIANT_RUNS: '32',
};

function forgeTest() {
  // Run from the project folder: with `--root`, forge writes its failure cache into the caller's folder.
  const r = spawnSync('forge', ['test'], { cwd: root, env, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const failed = new Set([...out.matchAll(/^\[FAIL.*?\] (\w+)\(/gm)].map((m) => m[1]));
  const compiled = !/Compiler run failed|^Error: /m.test(out) || failed.size > 0;
  return { ok: r.status === 0, compiled, failed, out };
}

const originals = new Map();
function restore() {
  for (const [path, text] of originals) writeFileSync(path, text);
  originals.clear();
}
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

const filter = process.argv[2] ?? '';
const rules = RULES.filter((rule) => rule.id.includes(filter));

const baseline = forgeTest();
if (!baseline.ok) {
  console.error(baseline.out.split('\n').slice(-30).join('\n'));
  console.error('The tests do not pass before any rule is removed. Fix that first.');
  process.exit(1);
}

let survivors = 0;
for (const rule of rules) {
  const path = join(root, rule.file);
  const source = readFileSync(path, 'utf8');
  if (source.split(rule.find).length !== 2) {
    console.log(`STALE   ${rule.id}: the text to remove is not in ${rule.file} exactly once`);
    survivors++;
    continue;
  }
  originals.set(path, source);
  let result;
  try {
    writeFileSync(path, source.replace(rule.find, rule.replace));
    result = forgeTest();
  } finally {
    restore();
  }
  if (!result.compiled) {
    console.log(`BROKEN  ${rule.id}: does not compile with the rule removed, so nothing is shown`);
    survivors++;
  } else if (result.failed.has(rule.expect)) {
    console.log(`bites   ${rule.id}: ${rule.expect} fails (${result.failed.size} tests fail)`);
  } else {
    const others = [...result.failed].join(', ') || 'none';
    console.log(`SILENT  ${rule.id}: ${rule.expect} still passes (failing: ${others})`);
    survivors++;
  }
}

console.log(`\n${rules.length - survivors} of ${rules.length} rules bite.`);
process.exit(survivors === 0 ? 0 : 1);
