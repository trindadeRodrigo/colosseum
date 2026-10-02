// Each rule bites: take one check out of the vault program, rebuild, run the suite, and
// see that the test named for that rule fails. Then put the check back.
//
//   pnpm --dir programs/tests rules-bite            every rule (a rebuild each, a few minutes)
//   pnpm --dir programs/tests rules-bite owner      only rules whose name contains "owner"
//
// It edits files under programs/basket/src while it runs and restores them when it ends,
// also on Ctrl-C. Do not edit those files or run the tests at the same time.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SRC = join(ROOT, 'programs', 'basket', 'src');
const BUILD = ['build', '--no-idl', '-p', 'basket', '--', '--tools-version', 'v1.54'];

const requireLine = (condition) =>
  new RegExp(`    require!\\(\\s*${condition},\\s*BasketError::\\w+\\s*\\);\\n`);

/** rule: what is removed. file, find, replace: the edit. fails: a test that must then fail. */
const RULES = [
  {
    rule: 'withdraw: the signer is the vault owner',
    file: 'instructions/withdraw.rs',
    find: '#[account(mut, has_one = owner)]',
    replace: '#[account(mut)]',
    fails: 'another signer cannot withdraw',
  },
  {
    rule: 'withdraw: the owner signs',
    file: 'instructions/withdraw.rs',
    find: "pub owner: Signer<'info>,",
    replace: "/// CHECK: rule removed\n    pub owner: UncheckedAccount<'info>,",
    fails: 'the owner must sign',
  },
  {
    rule: 'withdraw: the destination belongs to the owner',
    file: 'instructions/withdraw.rs',
    find: /mut,\s+constraint = destination\.owner == vault\.owner @ BasketError::WrongDestination/,
    replace: 'mut',
    fails: "the owner cannot withdraw to a third party's token account",
  },
  {
    rule: "withdraw: only from the vault's associated token account",
    file: 'instructions/withdraw.rs',
    find: /mut,\s+associated_token::mint = mint,\s+associated_token::authority = vault,\s+associated_token::token_program = token_program/,
    replace: 'mut',
    fails: "withdraws only from the vault's associated token account",
  },
  {
    rule: 'withdraw: extra accounts reach the token program',
    file: 'instructions/withdraw.rs',
    find: 'ctx.remaining_accounts,',
    replace: '&[],',
    fails: 'passes extra accounts on to the token program',
  },
  {
    rule: 'deposit: the signer is the vault owner',
    file: 'instructions/deposit.rs',
    find: '#[account(mut, has_one = owner)]',
    replace: '#[account(mut)]',
    fails: 'another signer cannot deposit into the vault',
  },
  {
    rule: "deposit: only into the vault's associated token account",
    file: 'instructions/deposit.rs',
    find: /mut,\s+associated_token::mint = mint,\s+associated_token::authority = vault,\s+associated_token::token_program = token_program/,
    replace: 'mut',
    fails: "deposits only into the vault's associated token account",
  },
  {
    rule: 'init_config: the signer is the upgrade authority',
    file: 'instructions/config.rs',
    find: 'constraint = program_data.upgrade_authority_address == Some(authority.key())',
    replace: 'constraint = true',
    fails: 'refuses a signer who is not the upgrade authority',
  },
  {
    rule: "init_config: the program data account is this program's",
    file: 'instructions/config.rs',
    find: 'constraint = program.programdata_address()? == Some(program_data.key())',
    replace: 'constraint = true',
    fails: "refuses another program's data account",
  },
  {
    rule: 'set_router, set_price_owner: the signer is the admin',
    file: 'instructions/config.rs',
    find: '#[account(mut, has_one = admin)]',
    replace: '#[account(mut)]',
    fails: 'cannot be changed by anyone else',
  },
  {
    rule: 'params: tolerance at most 300 bps',
    file: 'checks.rs',
    find: requireLine('params\\.tolerance_bps <= MAX_TOLERANCE_BPS'),
    replace: '',
    fails: 'refuses a tolerance above 300 bps',
  },
  {
    rule: 'params: loss cap at most 500 bps',
    file: 'checks.rs',
    find: requireLine('params\\.loss_cap_bps <= MAX_LOSS_CAP_BPS'),
    replace: '',
    fails: 'refuses a weekly loss cap above 500 bps',
  },
  {
    rule: 'params: cooldown at least 600 s',
    file: 'checks.rs',
    find: requireLine('params\\.asset_cooldown_s >= MIN_ASSET_COOLDOWN_S'),
    replace: '',
    fails: 'refuses a cooldown under 600 s',
  },
  {
    rule: 'params: publish delay at least 60 s',
    file: 'checks.rs',
    find: requireLine('params\\.publish_delay_s >= MIN_PUBLISH_DELAY_S'),
    replace: '',
    fails: 'refuses a publish delay under 60 s',
  },
  {
    rule: 'targets: no more than the vault has room for',
    file: 'checks.rs',
    find: '    require!(targets.len() <= MAX_POSITIONS, BasketError::InvalidTargets);\n',
    replace: '',
    fails: 'refuses more targets than the vault has room for',
  },
  {
    rule: 'targets: each mint once',
    file: 'checks.rs',
    find: / {8}require!\(\s*targets\[\.\.i\]\.iter\(\)\.all\(\|other\| other\.mint != target\.mint\),\s*BasketError::InvalidTargets\s*\);\n/,
    replace: '',
    fails: 'refuses the same mint twice in the targets',
  },
  {
    rule: 'targets: weights add up to at most the whole',
    file: 'checks.rs',
    find: '    require!(total <= BPS, BasketError::InvalidTargets);\n',
    replace: '',
    fails: 'refuses targets that add up to more than the whole',
  },
  {
    rule: 'create_vault: no version without a shared portfolio',
    file: 'instructions/create_vault.rs',
    find: '        require!(expected_version == 0, BasketError::VersionMismatch);\n',
    replace: '',
    fails: 'refuses an expected version when no shared portfolio is passed',
  },
];

function build() {
  const result = spawnSync('anchor', BUILD, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`build failed:\n${result.stderr.slice(-3000)}`);
}

/** Full names of the tests that fail. */
function failingTests() {
  const out = join(mkdtempSync(join(tmpdir(), 'rules-bite-')), 'report.json');
  // No global setup here: the binary was built a moment ago, on purpose, from edited source.
  spawnSync('pnpm', ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${out}`], {
    cwd: HERE,
    encoding: 'utf8',
  });
  const report = JSON.parse(readFileSync(out, 'utf8'));
  return report.testResults.flatMap((file) =>
    file.assertionResults.filter((t) => t.status === 'failed').map((t) => t.fullName),
  );
}

const filter = process.argv[2];
const selected = RULES.filter((r) => !filter || r.rule.includes(filter));
if (!selected.length) throw new Error(`no rule matches "${filter}"`);

let restore = () => {};
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});

if (failingTests().length) throw new Error('the suite must pass before any rule is removed');

const survivors = [];
for (const { rule, file, find, replace, fails } of selected) {
  const path = join(SRC, file);
  const original = readFileSync(path, 'utf8');
  const matches = original.split(find).length - 1;
  if (matches !== 1)
    throw new Error(`${rule}: the text to remove occurs ${matches} times in ${file}`);
  restore = () => writeFileSync(path, original);
  try {
    writeFileSync(path, original.replace(find, replace));
    build();
    const failed = failingTests();
    const bites = failed.some((name) => name.includes(fails));
    if (!bites) survivors.push(rule);
    console.log(`${bites ? 'bites   ' : 'SURVIVES'}  ${rule}`);
    console.log(
      `          fails: ${failed.length ? failed.join('\n                 ') : 'nothing'}`,
    );
  } finally {
    restore();
    restore = () => {};
  }
}

build();
if (failingTests().length) throw new Error('the suite fails after the checks were put back');
console.log(`\n${selected.length - survivors.length} of ${selected.length} rules bite.`);
if (survivors.length) {
  console.error(`No test noticed these being removed:\n  ${survivors.join('\n  ')}`);
  process.exit(1);
}
