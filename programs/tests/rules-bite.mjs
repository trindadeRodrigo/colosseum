// Each rule bites: take one check out of the vault program, rebuild, run the suite, and
// see that the test named for that rule fails. Then put the check back.
//
//   pnpm --dir programs/tests rules-bite            every rule (a rebuild each, a few minutes)
//   pnpm --dir programs/tests rules-bite owner      only rules whose name contains "owner"
//
// It edits files under programs/basket while it runs and restores them when it ends, also
// on Ctrl-C and on a kill. Do not edit those files or run the tests at the same time.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PROGRAM = join(ROOT, 'programs', 'basket');
const BUILD = ['build', '--no-idl', '-p', 'basket', '--', '--tools-version', 'v1.54'];

const requireLine = (indent, condition) =>
  new RegExp(`${indent}require!\\(\\s*${condition},\\s*BasketError::\\w+\\s*\\);\\n`);
const ASSOCIATED =
  /mut,\s+associated_token::mint = mint,\s+associated_token::authority = vault,\s+associated_token::token_program = token_program/;

/**
 * rule: what is removed. file, find, replace: the edit, in programs/basket.
 * fails: a test that must then fail.
 * cannotBite: instead of `fails`, why no test in LiteSVM can notice the edit. The edit is
 * still made and the suite still run, so the day a test does notice, this says so.
 */
const RULES = [
  {
    rule: 'withdraw: the signer is the vault owner',
    file: 'src/instructions/withdraw.rs',
    find: '#[account(mut, has_one = owner)]',
    replace: '#[account(mut)]',
    fails: 'another signer cannot withdraw',
  },
  {
    rule: 'withdraw: the owner signs',
    file: 'src/instructions/withdraw.rs',
    find: "pub owner: Signer<'info>,",
    replace: "/// CHECK: rule removed\n    pub owner: UncheckedAccount<'info>,",
    fails: 'the owner must sign',
  },
  {
    rule: 'withdraw: the destination belongs to the owner',
    file: 'src/instructions/withdraw.rs',
    find: /mut,\s+constraint = destination\.owner == vault\.owner @ BasketError::WrongDestination/,
    replace: 'mut',
    fails: "the owner cannot withdraw to a third party's token account",
  },
  {
    rule: "withdraw: only from the vault's associated token account",
    file: 'src/instructions/withdraw.rs',
    find: ASSOCIATED,
    replace: 'mut',
    fails: "withdraws only from the vault's associated token account",
  },
  {
    rule: "withdraw: the token program is the mint's own",
    file: 'src/instructions/withdraw.rs',
    find: '    #[account(mint::token_program = token_program)]\n',
    replace: '',
    fails: 'refuses a token program that is not the one the mint belongs to',
  },
  {
    rule: 'withdraw: extra accounts reach the token program',
    file: 'src/instructions/withdraw.rs',
    find: 'ctx.remaining_accounts,',
    replace: '&[],',
    fails: 'passes extra accounts on to the token program',
  },
  {
    rule: 'transfer: extra accounts carry no signature',
    file: 'src/transfer.rs',
    find: 'is_signer: false,',
    replace: 'is_signer: account.is_signer,',
    cannotBite:
      'Token-2022 itself calls a hook with no signer among the extra accounts, whatever it was handed, and the classic program ignores them. The line guards against a token program that would not.',
  },
  {
    rule: 'deposit: the signer is the vault owner',
    file: 'src/instructions/deposit.rs',
    find: '    #[account(has_one = owner)]\n',
    replace: '',
    fails: 'another signer cannot deposit into the vault',
  },
  {
    rule: 'deposit: the cash mint only',
    file: 'src/instructions/deposit.rs',
    find: /,\s+constraint = mint\.key\(\) == config\.cash_mint @ BasketError::NotCashMint/,
    replace: '',
    fails: 'as any other token: a deposit is refused',
  },
  {
    rule: 'deposit: Config is the one at its own address',
    file: 'src/instructions/deposit.rs',
    find: / {4}#\[account\(\s+seeds = \[CONFIG_SEED\],\s+bump = config\.bump\s+\)\]\n/,
    replace: '',
    fails: 'takes the cash mint from the real Config only',
  },
  {
    rule: "deposit: the token program is the mint's own",
    file: 'src/instructions/deposit.rs',
    find: /mint::token_program = token_program,\s+/,
    replace: '',
    fails: 'refuses a token program that is not the one the mint belongs to',
  },
  {
    rule: "deposit: only into the vault's associated token account",
    file: 'src/instructions/deposit.rs',
    find: ASSOCIATED,
    replace: 'mut',
    fails: "deposits only into the vault's associated token account",
  },
  {
    rule: 'init_config: the signer is the upgrade authority',
    file: 'src/instructions/config.rs',
    find: 'constraint = program_data.upgrade_authority_address == Some(authority.key())',
    replace: 'constraint = true',
    fails: 'refuses a signer who is not the upgrade authority',
  },
  {
    rule: "init_config: the program data account is this program's",
    file: 'src/instructions/config.rs',
    find: 'constraint = program.programdata_address()? == Some(program_data.key())',
    replace: 'constraint = true',
    fails: "refuses another program's data account",
  },
  {
    rule: 'setters: the signer is the admin',
    file: 'src/instructions/config.rs',
    find: /bump = config\.bump,\s+has_one = admin/,
    replace: 'bump = config.bump',
    fails: 'cannot be changed by anyone else',
  },
  {
    rule: 'setters: Config is the one at its own address',
    file: 'src/instructions/config.rs',
    find: /seeds = \[CONFIG_SEED\],\s+bump = config\.bump,\s+/,
    replace: '',
    fails: 'refuses a forged Config at another address',
  },
  {
    rule: 'setters: not the zero address',
    file: 'src/checks.rs',
    find: requireLine('    ', '\\*address != Pubkey::default\\(\\)'),
    replace: '',
    fails: 'cannot be set to the zero address',
  },
  {
    rule: 'no on-chain IDL account',
    file: 'Cargo.toml',
    find: 'default = ["no-idl"]',
    replace: 'default = []',
    fails: "refuses Anchor's instruction that creates an on-chain IDL account",
  },
  {
    rule: 'params: tolerance at most 300 bps',
    file: 'src/checks.rs',
    find: requireLine('    ', 'params\\.tolerance_bps <= MAX_TOLERANCE_BPS'),
    replace: '',
    fails: 'refuses a tolerance above 300 bps',
  },
  {
    rule: 'params: loss cap at most 500 bps',
    file: 'src/checks.rs',
    find: requireLine('    ', 'params\\.loss_cap_bps <= MAX_LOSS_CAP_BPS'),
    replace: '',
    fails: 'refuses a weekly loss cap above 500 bps',
  },
  {
    rule: 'params: cooldown at least 600 s',
    file: 'src/checks.rs',
    find: requireLine('    ', 'params\\.asset_cooldown_s >= MIN_ASSET_COOLDOWN_S'),
    replace: '',
    fails: 'refuses a cooldown under 600 s',
  },
  {
    rule: 'params: publish delay at least 60 s',
    file: 'src/checks.rs',
    find: requireLine('    ', 'params\\.publish_delay_s >= MIN_PUBLISH_DELAY_S'),
    replace: '',
    fails: 'refuses a publish delay under 60 s',
  },
  {
    rule: 'targets: no more than the vault has room for',
    file: 'src/checks.rs',
    find: requireLine('    ', 'targets\\.len\\(\\) <= MAX_POSITIONS'),
    replace: '',
    fails: 'refuses more targets than the vault has room for',
  },
  {
    rule: 'targets: never the zero address',
    file: 'src/checks.rs',
    find: requireLine('        ', 'target\\.mint != Pubkey::default\\(\\)'),
    replace: '',
    fails: 'refuses the zero address as a target',
  },
  {
    rule: 'targets: each mint once',
    file: 'src/checks.rs',
    find: requireLine(
      '        ',
      'targets\\[\\.\\.i\\]\\.iter\\(\\)\\.all\\(\\|other\\| other\\.mint != target\\.mint\\)',
    ),
    replace: '',
    fails: 'refuses the same mint twice in the targets',
  },
  {
    rule: 'targets: weights add up to at most the whole',
    file: 'src/checks.rs',
    find: requireLine('    ', 'total <= BPS'),
    replace: '',
    fails: 'refuses targets that add up to more than the whole',
  },
  {
    rule: 'create_vault: no version without a shared portfolio',
    file: 'src/instructions/create_vault.rs',
    find: requireLine('        ', 'expected_version == 0'),
    replace: '',
    fails: 'refuses an expected version when no shared portfolio is passed',
  },
];

function build() {
  const result = spawnSync('anchor', BUILD, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`build failed:\n${result.stderr.slice(-3000)}`);
}

/** Full names of the tests that fail. The suite's global setup runs too, and leaves the
 * binary alone: it was built a moment ago, so it is newer than the edited source. */
function failingTests() {
  const out = join(mkdtempSync(join(tmpdir(), 'rules-bite-')), 'report.json');
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
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore();
    process.exit(1);
  });
}

if (failingTests().length) throw new Error('the suite must pass before any rule is removed');

const survivors = [];
let known = 0;
for (const { rule, file, find, replace, fails, cannotBite } of selected) {
  const path = join(PROGRAM, file);
  const original = readFileSync(path, 'utf8');
  const matches = original.split(find).length - 1;
  if (matches !== 1)
    throw new Error(`${rule}: the text to remove occurs ${matches} times in ${file}`);
  restore = () => writeFileSync(path, original);
  try {
    writeFileSync(path, original.replace(find, replace));
    build();
    const failed = failingTests();
    const list = failed.length ? failed.join('\n                 ') : 'nothing';
    if (cannotBite) {
      known += 1;
      console.log(`${failed.length ? 'NOW BITES' : 'known gap'} ${rule}`);
      console.log(`          why no test can notice: ${cannotBite}`);
      if (failed.length) console.log(`          but these fail now; give it a test: ${list}`);
      continue;
    }
    const bites = failed.some((name) => name.includes(fails));
    if (!bites) survivors.push(rule);
    console.log(`${bites ? 'bites   ' : 'SURVIVES'}  ${rule}`);
    console.log(`          fails: ${list}`);
  } finally {
    restore();
    restore = () => {};
  }
}

build();
if (failingTests().length) throw new Error('the suite fails after the checks were put back');
const tested = selected.length - known;
console.log(`\n${tested - survivors.length} of ${tested} rules bite.`);
if (known) console.log(`${known} listed that no test in LiteSVM can notice.`);
if (survivors.length) {
  console.error(`No test noticed these being removed:\n  ${survivors.join('\n  ')}`);
  process.exit(1);
}
