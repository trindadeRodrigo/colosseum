// Each rule bites: take one check out of the vault program, rebuild, run the suite, and
// see that the test named for that rule fails. Then put the check back.
//
//   pnpm --dir programs/tests rules-bite            every rule (a rebuild each, a few minutes)
//   pnpm --dir programs/tests rules-bite owner      only rules whose name contains "owner"
//   pnpm --dir programs/tests rules-bite "a: b" "c: d"   several names: the rules that contain any
//   pnpm --dir programs/tests rules-bite --check    builds nothing: only that the table is sound
//   pnpm --dir programs/tests rules-bite --from=upsert_asset   from the first rule with that in its
//                                                   name to the end: for a run that was cut short
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
const associated = (side) =>
  new RegExp(
    `mut,\\s+associated_token::mint = ${side}_mint,\\s+associated_token::authority = vault,\\s+associated_token::token_program = ${side}_token_program`,
  );
/** Config read by an instruction that does not change it, pinned to its own address. */
const CONFIG_PINNED = / {4}#\[account\(\s+seeds = \[CONFIG_SEED\],\s+bump = config\.bump\s+\)\]\n/;
/** The asset list, pinned to its own address. */
const ASSETS_PINNED = / {4}#\[account\(\s+seeds = \[ASSETS_SEED\],\s+bump\s+\)\]\n/;
/** Config with `has_one`: the address check alone is taken out. */
const pinnedWith = (role) =>
  new RegExp(`seeds = \\[CONFIG_SEED\\],\\s+bump = config\\.bump,\\s+has_one = ${role}\\b`);
const hasOne = (role) => new RegExp(`bump = config\\.bump,\\s+has_one = ${role}\\b`);
const SIGNER = (name) => `pub ${name}: Signer<'info>,`;
const UNSIGNED = (name) => `/// CHECK: rule removed\n    pub ${name}: UncheckedAccount<'info>,`;
/** One of the author limits: `if <condition> { return Err(LimitReason::<name>); }`. */
const limit = (name) =>
  new RegExp(` {4}if [^{}]*\\{\\s*return Err\\(LimitReason::${name}\\);\\s*\\}\\n`);

/**
 * rule: what is removed. file, find, replace: the edit, in programs/basket.
 * within: the edit is made only inside the block that starts on the line holding this text
 *   (a struct, an impl or a function), for text that also occurs elsewhere in the file.
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
    find: SIGNER('owner'),
    replace: UNSIGNED('owner'),
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
    fails:
      'basket vault with a funded vault accounts that are not what they are passed as refuses a token program',
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
    rule: 'deposit: the owner signs',
    file: 'src/instructions/deposit.rs',
    find: SIGNER('owner'),
    replace: UNSIGNED('owner'),
    fails: 'the owner must sign a deposit',
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
    find: CONFIG_PINNED,
    replace: '',
    fails: 'takes the cash mint from the real Config only',
  },
  {
    rule: "deposit: the token program is the mint's own",
    file: 'src/instructions/deposit.rs',
    find: /mint::token_program = token_program,\s+/,
    replace: '',
    fails:
      'basket vault with a funded vault accounts that are not what they are passed as refuses a token program',
  },
  {
    rule: "deposit: only into the vault's associated token account",
    file: 'src/instructions/deposit.rs',
    find: ASSOCIATED,
    replace: 'mut',
    fails: "deposits only into the vault's associated token account",
  },

  // ---- Config ----
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
  ...['guardian', 'default_keeper', 'router_program', 'price_owner'].map((field) => ({
    rule: `init_config: ${field} is not the zero address`,
    file: 'src/instructions/config.rs',
    find: `        check_address(&args.${field})?;\n`,
    replace: '',
    fails: `refuses the zero address as ${field.replace(/_(\w)/g, (_, c) => c.toUpperCase())}`,
  })),
  {
    rule: 'init_config: the router is not a program that reads a signature as leave to move tokens',
    file: 'src/instructions/config.rs',
    find: '        check_router(&args.router_program)?;\n',
    replace: '',
    fails: 'initialise refuses the token program as the router',
  },
  {
    rule: 'init_config: the parameters are checked',
    file: 'src/instructions/config.rs',
    find: '        check_params(&args.params, false)?;\n',
    replace: '',
    fails: 'hard bounds on the parameters refuses a tolerance above 300 bps',
  },
  {
    rule: 'init_config: the cash mint is a mint of a token program',
    file: 'src/instructions/config.rs',
    within: 'pub struct InitConfig<',
    find: "pub cash_mint: InterfaceAccount<'info, Mint>,",
    replace: UNSIGNED('cash_mint'),
    fails: 'refuses a cash mint that is not a mint of a token program',
  },
  {
    rule: 'admin: the signer is the admin',
    file: 'src/instructions/config.rs',
    within: 'pub struct SetConfig',
    find: hasOne('admin'),
    replace: 'bump = config.bump',
    fails: 'cannot be changed by anyone else',
  },
  {
    rule: 'admin: the admin signs',
    file: 'src/instructions/config.rs',
    within: 'pub struct SetConfig',
    find: SIGNER('admin'),
    replace: UNSIGNED('admin'),
    fails: 'is not enough: each must sign',
  },
  {
    rule: 'admin: Config is the one at its own address',
    file: 'src/instructions/config.rs',
    within: 'pub struct SetConfig',
    find: pinnedWith('admin'),
    replace: 'has_one = admin',
    fails: 'refuses a forged Config at another address',
  },
  {
    rule: 'set_cash_mint: the signer is the admin',
    file: 'src/instructions/config.rs',
    within: 'pub struct SetCashMint',
    find: hasOne('admin'),
    replace: 'bump = config.bump',
    fails: 'cashMint cannot be changed by anyone else',
  },
  {
    rule: 'set_cash_mint: the admin signs',
    file: 'src/instructions/config.rs',
    within: 'pub struct SetCashMint',
    find: SIGNER('admin'),
    replace: UNSIGNED('admin'),
    fails: 'is not enough: each must sign',
  },
  {
    rule: 'set_cash_mint: Config is the one at its own address',
    file: 'src/instructions/config.rs',
    within: 'pub struct SetCashMint',
    find: pinnedWith('admin'),
    replace: 'has_one = admin',
    fails: 'refuses a forged Config at another address',
  },
  {
    rule: 'set_cash_mint: the cash mint is a mint of a token program',
    file: 'src/instructions/config.rs',
    within: 'pub struct SetCashMint',
    find: "pub cash_mint: InterfaceAccount<'info, Mint>,",
    replace: UNSIGNED('cash_mint'),
    fails: 'the cash mint cannot be set to what is not a mint of a token program',
  },
  {
    rule: 'set_router: not the zero address',
    file: 'src/instructions/config.rs',
    within: 'pub fn set_router(',
    find: '        check_address(&router_program)?;\n',
    replace: '',
    fails: 'routerProgram cannot be set to the zero address',
  },
  {
    rule: 'set_price_owner: not the zero address',
    file: 'src/instructions/config.rs',
    within: 'pub fn set_price_owner(',
    find: '        check_address(&price_owner)?;\n',
    replace: '',
    fails: 'priceOwner cannot be set to the zero address',
  },
  {
    rule: 'set_params: the parameters are checked',
    file: 'src/instructions/config.rs',
    find: '        check_params(&params, config.launched)?;\n',
    replace: '',
    fails: 'holds the hard bounds: refuses a tolerance above 300 bps',
  },
  {
    rule: 'setters: not the zero address',
    file: 'src/checks.rs',
    find: requireLine('    ', '\\*address != Pubkey::default\\(\\)'),
    replace: '',
    fails: 'cannot be set to the zero address',
  },
  {
    rule: 'set_router: the router is checked',
    file: 'src/instructions/config.rs',
    find: '        check_router(&router_program)?;\n',
    replace: '',
    fails: 'the router cannot be set to the token program',
  },
  {
    rule: 'router: never the token program',
    file: 'src/checks.rs',
    find: requireLine('    ', '\\*router != anchor_spl::token::ID'),
    replace: '',
    fails: 'the router cannot be set to the token program',
  },
  {
    rule: 'router: never the Token-2022 program',
    file: 'src/checks.rs',
    find: requireLine('    ', '\\*router != anchor_spl::token_2022::ID'),
    replace: '',
    fails: 'the router cannot be set to the Token-2022 program',
  },
  {
    rule: 'router: never the system program',
    file: 'src/checks.rs',
    find: requireLine('    ', '\\*router != anchor_lang::system_program::ID'),
    replace: '',
    fails: 'never calls the system program, even if Config named it',
  },
  {
    rule: 'router: never the vault program itself',
    file: 'src/checks.rs',
    find: requireLine('    ', '\\*router != crate::ID'),
    replace: '',
    fails: 'the router cannot be set to the vault program itself',
  },
  {
    rule: 'launch: what it locks stays locked',
    file: 'src/instructions/config.rs',
    find: requireLine('    ', '!config\\.launched'),
    replace: '',
    fails: 'locks the router',
  },
  ...[
    ['set_router', 'the router'],
    ['set_price_owner', 'the price owner'],
    ['set_cash_mint', 'the cash mint'],
  ].map(([name, what]) => ({
    rule: `launch: ${name} is refused after it`,
    file: 'src/instructions/config.rs',
    within: `pub fn ${name}(`,
    find: '        check_not_launched(&ctx.accounts.config)?;\n',
    replace: '',
    fails: `locks ${what}`,
  })),
  {
    rule: 'launch: one way, a second launch is refused',
    file: 'src/instructions/config.rs',
    find: '        check_not_launched(config)?;\n',
    replace: '',
    fails: 'is one way: it sets the latch',
  },
  {
    rule: 'launch: raises the publish delay to two days',
    file: 'src/instructions/config.rs',
    find: '        config.publish_delay_s = config.publish_delay_s.max(LAUNCHED_PUBLISH_DELAY_S);\n',
    replace: '',
    fails: 'is one way: it sets the latch',
  },
  {
    rule: 'accept_admin: the signer is the proposed admin',
    file: 'src/instructions/config.rs',
    find: hasOne('pending_admin'),
    replace: 'bump = config.bump',
    fails: 'only the proposed key accepts',
  },
  {
    rule: 'accept_admin: the proposed admin signs',
    file: 'src/instructions/config.rs',
    find: SIGNER('pending_admin'),
    replace: UNSIGNED('pending_admin'),
    fails: 'is not enough: each must sign',
  },
  {
    rule: 'accept_admin: Config is the one at its own address',
    file: 'src/instructions/config.rs',
    find: pinnedWith('pending_admin'),
    replace: 'has_one = pending_admin',
    fails: 'refuses a forged Config that names the signer as the proposed admin',
  },
  {
    rule: 'pause_keeper: the signer is the guardian',
    file: 'src/instructions/config.rs',
    find: hasOne('guardian'),
    replace: 'bump = config.bump',
    fails: 'nobody but the guardian pauses',
  },
  {
    rule: 'pause_keeper: the guardian signs',
    file: 'src/instructions/config.rs',
    find: SIGNER('guardian'),
    replace: UNSIGNED('guardian'),
    fails: 'is not enough: each must sign',
  },
  {
    rule: 'pause_keeper: Config is the one at its own address',
    file: 'src/instructions/config.rs',
    find: pinnedWith('guardian'),
    replace: 'has_one = guardian',
    fails: 'the keeper pause refuses a forged Config',
  },
  {
    rule: 'no on-chain IDL account',
    file: 'Cargo.toml',
    find: 'default = ["no-idl"]',
    replace: 'default = []',
    fails: "refuses Anchor's instruction that creates an on-chain IDL account",
  },

  // ---- parameters ----
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
    rule: 'params: band at most 500 bps',
    file: 'src/checks.rs',
    find: requireLine('    ', 'params\\.band_bps <= MAX_BAND_BPS'),
    replace: '',
    fails: 'refuses a band above 500 bps',
  },
  {
    rule: 'params: price deviation allowance at most 1,000 bps',
    file: 'src/checks.rs',
    find: requireLine('    ', 'params\\.twap_dev_bps <= MAX_TWAP_DEV_BPS'),
    replace: '',
    fails: 'refuses a price deviation allowance above 1,000 bps',
  },
  {
    rule: 'params: price age at most 600 s',
    file: 'src/checks.rs',
    find: requireLine('    ', 'params\\.max_price_age_s <= MAX_PRICE_AGE_S'),
    replace: '',
    fails: 'refuses a price older than 600 s',
  },
  {
    rule: 'params: cooldown at least 600 s',
    file: 'src/checks.rs',
    find: requireLine('    ', 'params\\.asset_cooldown_s >= MIN_ASSET_COOLDOWN_S'),
    replace: '',
    fails: 'refuses a cooldown under 600 s',
  },
  {
    rule: 'params: cooldown at most 7 days',
    file: 'src/checks.rs',
    find: requireLine('    ', 'params\\.asset_cooldown_s <= MAX_ASSET_COOLDOWN_S'),
    replace: '',
    fails: 'refuses a cooldown over 7 days',
  },
  {
    rule: 'params: publish delay at most 30 days',
    file: 'src/checks.rs',
    find: requireLine('    ', 'params\\.publish_delay_s <= MAX_PUBLISH_DELAY_S'),
    replace: '',
    fails: 'refuses a publish delay over 30 days',
  },
  {
    rule: 'params: publish delay at least 60 s',
    file: 'src/checks.rs',
    find: requireLine('    ', 'params\\.publish_delay_s >= MIN_PUBLISH_DELAY_S'),
    replace: '',
    fails: 'refuses a publish delay under 60 s',
  },
  {
    rule: 'params: publish delay at least two days after launch',
    file: 'src/checks.rs',
    find: requireLine(
      '    ',
      '!launched \\|\\| params\\.publish_delay_s >= LAUNCHED_PUBLISH_DELAY_S',
    ),
    replace: '',
    fails: 'after it the publish delay cannot go under two days',
  },
  {
    rule: 'params: the session opens no earlier than 13:30 UTC',
    file: 'src/checks.rs',
    find: requireLine('    ', 'params\\.session_open_utc_s >= MIN_SESSION_OPEN_UTC_S'),
    replace: '',
    fails: 'refuses a session that opens before 13:30 UTC',
  },
  {
    rule: 'params: the session closes no later than 21:00 UTC',
    file: 'src/checks.rs',
    find: requireLine('    ', 'params\\.session_close_utc_s <= MAX_SESSION_CLOSE_UTC_S'),
    replace: '',
    fails: 'refuses a session that closes after 21:00 UTC',
  },
  {
    rule: 'params: the session closes after it opens',
    file: 'src/checks.rs',
    find: requireLine('    ', 'params\\.session_open_utc_s < params\\.session_close_utc_s'),
    replace: '',
    fails: 'refuses a session that closes when it opens',
  },

  // ---- the asset list ----
  {
    rule: 'init_assets: the signer is the admin',
    file: 'src/instructions/assets.rs',
    within: 'pub struct InitAssets',
    find: hasOne('admin'),
    replace: 'bump = config.bump',
    fails: 'init_assets is the admin alone',
  },
  {
    rule: 'init_assets: Config is the one at its own address',
    file: 'src/instructions/assets.rs',
    within: 'pub struct InitAssets',
    find: pinnedWith('admin'),
    replace: 'has_one = admin',
    fails: 'init_assets refuses a forged Config',
  },
  {
    rule: 'upsert_asset: the signer is the admin',
    file: 'src/instructions/assets.rs',
    within: 'pub struct UpsertAsset',
    find: hasOne('admin'),
    replace: 'bump = config.bump',
    fails: 'upsert_asset is the admin alone',
  },
  {
    rule: 'upsert_asset: the admin signs',
    file: 'src/instructions/assets.rs',
    within: 'pub struct UpsertAsset',
    find: SIGNER('admin'),
    replace: UNSIGNED('admin'),
    fails: 'upsert_asset is the admin alone',
  },
  {
    rule: 'upsert_asset: Config is the one at its own address',
    file: 'src/instructions/assets.rs',
    within: 'pub struct UpsertAsset',
    find: pinnedWith('admin'),
    replace: 'has_one = admin',
    fails: 'writes only the real list, on the word of the real Config only',
  },
  {
    rule: 'upsert_asset: the asset list is the one at its own address',
    file: 'src/instructions/assets.rs',
    find: /mut,\s+seeds = \[ASSETS_SEED\],\s+bump/,
    replace: 'mut',
    fails: 'writes only the real list, on the word of the real Config only',
  },
  ...[
    ['\\(args\\.price_slot as usize\\) < MAX_PRICE_ACCOUNTS', 'a price slot past the four'],
    ['args\\.price_kind <= 1', 'a price kind that is not none or Scope'],
    ['args\\.price_index < PRICE_ENTRIES', 'a price index past the 512 entries'],
    ['args\\.twap_index < PRICE_ENTRIES', 'an average index past the 512 entries'],
    ['args\\.session <= 1', 'a session that is not always or US hours'],
    ['args\\.max_weight_bps as u32 <= BPS', 'a ceiling above the whole'],
    ['args\\.flags == 0', 'a flag, while no flag has a meaning'],
  ].map(([condition, what]) => ({
    rule: `upsert_asset: refuses ${what}`,
    file: 'src/instructions/assets.rs',
    find: requireLine('        ', condition),
    replace: '',
    fails: `refuses ${what}`,
  })),
  {
    rule: 'upsert_asset: no mint with a transfer hook program',
    file: 'src/instructions/assets.rs',
    find: requireLine('        ', '!has_hook_program\\(&mint\\.to_account_info\\(\\)\\)\\?'),
    replace: '',
    fails: 'refuses a mint with a transfer hook program',
  },
  {
    rule: 'hook list: a hook program is found wherever it sits in the mint',
    file: 'src/checks.rs',
    find: 'found = true;',
    replace: 'found = false;',
    fails: 'refuses a hook program that sits after pausable in the mint',
  },
  {
    rule: 'hook list: an entry cut off inside its header is refused',
    file: 'src/checks.rs',
    find: requireLine('        ', 'at \\+ 4 <= data\\.len\\(\\)'),
    replace: '',
    fails: 'is refused when the list is cut off inside an entry',
  },
  {
    rule: 'hook list: an entry longer than the mint is refused',
    file: 'src/checks.rs',
    find: requireLine('        ', 'value \\+ length <= data\\.len\\(\\)'),
    replace: '',
    fails: 'is refused when an entry says it is longer than the mint',
  },
  {
    rule: 'hook list: a hook entry too short to hold a program is refused',
    file: 'src/checks.rs',
    find: requireLine('            ', 'length >= TRANSFER_HOOK_LEN'),
    replace: '',
    fails: 'is refused when its hook entry is too short to hold a program',
  },
  {
    rule: 'upsert_asset: sixty-four entries and no more',
    file: 'src/instructions/assets.rs',
    find: requireLine('                ', 'count < MAX_ASSETS'),
    replace: '',
    fails: 'holds sixty-four tokens and no more',
  },

  // ---- the shared-portfolio registry ----
  {
    rule: 'publish_recipe: the address is derived from the creator',
    file: 'src/instructions/recipe.rs',
    find: 'seeds = [RECIPE_SEED, creator.key().as_ref(), &family_id],',
    replace: 'seeds = [RECIPE_SEED, &family_id],',
    // Without the creator in the address, whoever publishes a family id first owns it.
    fails: 'is one per creator per family',
  },
  {
    rule: 'publish_recipe: Config is the one at its own address',
    file: 'src/instructions/recipe.rs',
    within: 'pub struct PublishRecipe',
    find: CONFIG_PINNED,
    replace: '',
    fails: 'the first version is checked against the real Config',
  },
  {
    rule: 'publish_recipe: the asset list is the one at its own address',
    file: 'src/instructions/recipe.rs',
    within: 'pub struct PublishRecipe',
    find: ASSETS_PINNED,
    replace: '',
    fails: 'the first version is checked against the real Config',
  },
  {
    rule: 'publish_recipe: the fee and the flags are checked',
    file: 'src/instructions/recipe.rs',
    find: '        refuse_limit(check_header(max_fee_bps, flags))?;\n',
    replace: '',
    fails: 'the fee is 1 bp',
  },
  {
    rule: 'publish_recipe: the shape of the first version is checked',
    file: 'src/instructions/recipe.rs',
    within: 'impl PublishRecipe',
    find: '        refuse_limit(check_shape(&components, &*ctx.accounts.assets.load()?))?;\n',
    replace: '',
    fails: 'case 1: two assets',
  },
  {
    rule: 'publish_recipe: no cash in the first version',
    file: 'src/instructions/recipe.rs',
    find: '        refuse_limit(check_no_cash(&components, &ctx.accounts.config.cash_mint))?;\n',
    replace: '',
    fails: 'the cash token as a component',
  },
  {
    rule: 'update_recipe: the signer is the creator',
    file: 'src/instructions/recipe.rs',
    find: '#[account(mut, has_one = creator)]',
    replace: '#[account(mut)]',
    fails: 'a later version is the creator alone',
  },
  {
    rule: 'update_recipe: the creator signs',
    file: 'src/instructions/recipe.rs',
    within: 'pub struct UpdateRecipe',
    find: SIGNER('creator'),
    replace: UNSIGNED('creator'),
    fails: 'a later version is the creator alone',
  },
  {
    rule: 'update_recipe: Config is the one at its own address',
    file: 'src/instructions/recipe.rs',
    within: 'pub struct UpdateRecipe',
    find: CONFIG_PINNED,
    replace: '',
    fails: 'a later version is checked against the real Config',
  },
  {
    rule: 'update_recipe: the asset list is the one at its own address',
    file: 'src/instructions/recipe.rs',
    within: 'pub struct UpdateRecipe',
    find: ASSETS_PINNED,
    replace: '',
    fails: 'a later version is checked against the real Config',
  },
  {
    rule: 'update_recipe: a version whose time has come is the one in effect',
    file: 'src/instructions/recipe.rs',
    find: '        recipe.promote(now);\n',
    replace: '',
    fails: 'exactly when the waiting version takes effect',
  },
  {
    rule: 'update_recipe: the shape of a later version is checked',
    file: 'src/instructions/recipe.rs',
    within: 'impl UpdateRecipe',
    find: '        refuse_limit(check_shape(&components, &*ctx.accounts.assets.load()?))?;\n',
    replace: '',
    fails: 'a later version down to two assets',
  },
  {
    rule: 'update_recipe: no cash in a later version',
    file: 'src/instructions/recipe.rs',
    find: '        refuse_limit(check_no_cash(&components, &config.cash_mint))?;\n',
    replace: '',
    fails: 'a later version brings in the cash token',
  },
  {
    rule: 'publish_recipe: the time of the publish is recorded',
    file: 'src/instructions/recipe.rs',
    within: 'impl PublishRecipe',
    find: '        recipe.last_publish_ts = now;\n',
    replace: '',
    fails: 'case 37: one second too soon, 48-hour delay',
  },
  {
    rule: 'update_recipe: the time of the publish is recorded',
    file: 'src/instructions/recipe.rs',
    within: 'impl UpdateRecipe',
    find: '        recipe.last_publish_ts = now;\n',
    replace: '',
    fails: 'case 48: a cancelled version does not give the slot back',
  },
  {
    rule: 'update_recipe: a later version waits one publish delay',
    file: 'src/instructions/recipe.rs',
    find: 'let effective_at = now.saturating_add(config.publish_delay_s as i64);',
    replace: 'let effective_at = now;',
    fails: 'case 38: exactly on time, 48-hour delay',
  },
  {
    rule: 'cancel_pending: the creator or the guardian',
    file: 'src/instructions/recipe.rs',
    find: requireLine(
      '        ',
      'by == recipe\\.creator \\|\\| by == ctx\\.accounts\\.config\\.guardian',
    ),
    replace: '',
    fails: 'nobody else can, the admin included',
  },
  {
    rule: 'cancel_pending: whoever cancels signs',
    file: 'src/instructions/recipe.rs',
    find: SIGNER('signer'),
    replace: UNSIGNED('signer'),
    fails: 'nobody else can, the admin included',
  },
  {
    rule: 'cancel_pending: Config is the one at its own address',
    file: 'src/instructions/recipe.rs',
    within: 'pub struct CancelPending',
    find: CONFIG_PINNED,
    replace: '',
    fails: 'cancelling a version that waits refuses a forged Config',
  },
  {
    rule: 'cancel_pending: only a version that waits',
    file: 'src/instructions/recipe.rs',
    find: requireLine('        ', 'recipe\\.has_pending\\(now\\)'),
    replace: '',
    fails: 'there is nothing to cancel once nothing waits',
  },
  {
    rule: 'recipe: the number a version takes is recorded, cancelled or not',
    file: 'src/instructions/recipe.rs',
    find: '        recipe.last_version = version;\n',
    replace: '',
    fails: 'a cancelled version keeps its number',
  },
  {
    rule: 'recipe: a version number is never given out twice',
    file: 'src/state.rs',
    find: 'self.last_version.max(self.current.version) + 1',
    replace: 'self.current.version + 1',
    fails: 'a cancelled version keeps its number',
  },
  {
    rule: 'recipe: a version whose time has come no longer waits',
    file: 'src/state.rs',
    find: 'self.pending.version != 0 && now < self.pending.effective_at',
    replace: 'self.pending.version != 0',
    fails: 'a version whose time has come is in effect and cannot be cancelled',
  },
  {
    rule: 'recipe: a version whose time has come is in effect with no transaction',
    file: 'src/state.rs',
    within: 'pub fn active(',
    find: 'self.pending.version != 0 && now >= self.pending.effective_at',
    replace: 'false',
    fails: '(A18)',
  },
  ...[
    ['FeeNotZero', 'the fee is 1 bp'],
    ['FlagsNotZero', 'flags is 1'],
    ['TooFewAssets', 'case 1: two assets'],
    ['TooManyAssets', 'case 5: thirteen assets'],
    ['AssetNotListed', 'an asset that is not on the platform list'],
    ['DuplicateAsset', 'an asset twice, side by side'],
    ['WeightBelowMin', 'a weight one step under the floor'],
    ['WeightOffStep', 'weights half a step off'],
    ['WeightAboveCeiling', 'a weight one step over 50%'],
    ['WeightSum', 'one step short of 100%'],
    ['VersionPending', 'a version is pending though the interval has passed'],
    ['VersionTooSoon', 'one second too soon, 48-hour delay'],
    ['TurnoverTooHigh', 'case 53: one step over 20%'],
    ['CashNotAllowed', 'the cash token as a component'],
  ].map(([name, test]) => ({
    rule: `author limits: ${name}`,
    file: 'src/checks.rs',
    find: limit(name),
    replace: '',
    fails: test,
  })),
  {
    rule: 'author limits: no weight above 50%, whatever the ceiling of the asset',
    file: 'src/checks.rs',
    find: 'own.min(MAX_WEIGHT_BPS)',
    replace: 'own',
    fails: 'a ceiling over 50%: one step over 50% is refused',
  },

  // ---- targets ----
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
    rule: 'targets: never the cash mint',
    file: 'src/checks.rs',
    find: requireLine('        ', 'target\\.mint != \\*cash_mint'),
    replace: '',
    fails: 'refuses the cash mint as a target',
  },
  {
    rule: 'targets: only mints on the platform list',
    file: 'src/checks.rs',
    find: requireLine('        ', 'registry\\.is_listed\\(&target\\.mint\\)'),
    replace: '',
    fails: 'refuses a target that is not on the platform list',
  },
  {
    rule: 'targets: weights add up to at most the whole',
    file: 'src/checks.rs',
    find: requireLine('    ', 'total <= BPS'),
    replace: '',
    fails: 'refuses targets that add up to more than the whole',
  },

  // ---- create_vault ----
  {
    rule: 'create_vault: the address is derived from the owner',
    file: 'src/instructions/create_vault.rs',
    find: 'seeds = [VAULT_SEED, owner.key().as_ref(), &basket_id.to_le_bytes()],',
    replace: 'seeds = [VAULT_SEED, &basket_id.to_le_bytes()],',
    // Without the owner in the address, the first to use a plan id owns it for everyone.
    fails: 'gives each plan id and each owner a vault of its own',
  },
  {
    rule: 'create_vault: no version without a shared portfolio',
    file: 'src/instructions/create_vault.rs',
    find: requireLine('                ', 'expected_version == 0'),
    replace: '',
    fails: 'refuses an expected version when no shared portfolio is passed',
  },
  {
    rule: 'create_vault: the version in effect is the one the person reviewed',
    file: 'src/instructions/create_vault.rs',
    find: requireLine('                ', 'expected_version == active\\.version'),
    replace: '',
    fails: '(A18)',
  },
  {
    rule: 'create_vault: a vault that follows takes no targets of its own',
    file: 'src/instructions/create_vault.rs',
    find: requireLine('                ', 'targets\\.is_empty\\(\\)'),
    replace: '',
    fails: 'takes no targets of its own',
  },
  {
    rule: 'create_vault: the targets are checked',
    file: 'src/instructions/create_vault.rs',
    find: /check_targets\(\s+&targets,\s+&\*ctx\.accounts\.assets\.load\(\)\?,\s+&ctx\.accounts\.config\.cash_mint,\s+\)\?;/,
    replace: '',
    fails: 'create refuses the same mint twice in the targets',
  },
  {
    rule: 'create_vault: Config is the one at its own address',
    file: 'src/instructions/create_vault.rs',
    find: CONFIG_PINNED,
    replace: '',
    fails: 'takes the cash mint and the list from the real Config',
  },
  {
    rule: 'create_vault: the asset list is the one at its own address',
    file: 'src/instructions/create_vault.rs',
    find: ASSETS_PINNED,
    replace: '',
    fails: 'takes the cash mint and the list from the real Config',
  },

  // ---- set_targets ----
  {
    rule: 'set_targets: the signer is the vault owner',
    file: 'src/instructions/set_targets.rs',
    find: '#[account(mut, has_one = owner)]',
    replace: '#[account(mut)]',
    fails: 'set_targets is the owner alone',
  },
  {
    rule: 'set_targets: the owner signs',
    file: 'src/instructions/set_targets.rs',
    find: SIGNER('owner'),
    replace: UNSIGNED('owner'),
    fails: 'set_targets is the owner alone',
  },
  {
    rule: 'set_targets: the targets are checked',
    file: 'src/instructions/set_targets.rs',
    find: /check_targets\(\s+&targets,\s+&\*ctx\.accounts\.assets\.load\(\)\?,\s+&ctx\.accounts\.config\.cash_mint,\s+\)\?;/,
    replace: '',
    fails: 'holds the rules of create refuses the same mint twice',
  },
  {
    rule: 'set_targets: Config is the one at its own address',
    file: 'src/instructions/set_targets.rs',
    find: CONFIG_PINNED,
    replace: '',
    fails: 'set_targets reads the cash mint and the list from the real Config',
  },
  {
    rule: 'set_targets: the asset list is the one at its own address',
    file: 'src/instructions/set_targets.rs',
    find: ASSETS_PINNED,
    replace: '',
    fails: 'set_targets reads the cash mint and the list from the real Config',
  },
  {
    rule: 'set_targets: the vault stops following',
    file: 'src/instructions/set_targets.rs',
    find: '        vault.recipe = Pubkey::default();\n',
    replace: '',
    fails: 'stops following',
  },
  {
    rule: 'set_targets: auto-follow goes off',
    file: 'src/instructions/set_targets.rs',
    find: '        vault.auto_follow = false;\n',
    replace: '',
    fails: 'stops following',
  },

  // ---- owner_swap ----
  {
    rule: 'owner_swap: the signer is the vault owner',
    file: 'src/instructions/owner_swap.rs',
    find: '#[account(mut, has_one = owner)]',
    replace: '#[account(mut)]',
    fails: 'another signer cannot, and the owner must sign',
  },
  {
    rule: 'owner_swap: the owner signs',
    file: 'src/instructions/owner_swap.rs',
    find: SIGNER('owner'),
    replace: UNSIGNED('owner'),
    fails: 'another signer cannot, and the owner must sign',
  },
  {
    rule: 'owner_swap: Config is the one at its own address',
    file: 'src/instructions/owner_swap.rs',
    find: CONFIG_PINNED,
    replace: '',
    fails: 'reads the list and the cash mint from the real asset list and the real Config only',
  },
  {
    rule: 'owner_swap: the asset list is the one at its own address',
    file: 'src/instructions/owner_swap.rs',
    find: ASSETS_PINNED,
    replace: '',
    fails: 'reads the list and the cash mint from the real asset list and the real Config only',
  },
  {
    rule: "owner_swap: the input's token program is the mint's own",
    file: 'src/instructions/owner_swap.rs',
    find: '    #[account(mint::token_program = input_token_program)]\n',
    replace: '',
    fails: 'from which accounts refuses a token program',
  },
  {
    rule: "owner_swap: the output's token program is the mint's own",
    file: 'src/instructions/owner_swap.rs',
    find: /mint::token_program = output_token_program,\s+/,
    replace: '',
    fails: 'from which accounts refuses a token program',
  },
  {
    rule: 'owner_swap: two different mints',
    file: 'src/instructions/owner_swap.rs',
    find: /mint::token_program = output_token_program,\s+constraint = output_mint\.key\(\) != input_mint\.key\(\) @ BasketError::SameMint/,
    replace: 'mint::token_program = output_token_program',
    fails: 'refuses a trade of a token for itself',
  },
  {
    rule: "owner_swap: spends only from the vault's associated token account",
    file: 'src/instructions/owner_swap.rs',
    find: associated('input'),
    replace: 'mut',
    fails: "spends only from, and pays only into, the vault's associated token accounts",
  },
  {
    rule: "owner_swap: pays only into the vault's associated token account",
    file: 'src/instructions/owner_swap.rs',
    find: associated('output'),
    replace: 'mut',
    fails: "spends only from, and pays only into, the vault's associated token accounts",
  },
  {
    rule: 'owner_swap: the program called is the router in Config',
    file: 'src/instructions/owner_swap.rs',
    find: '    #[account(address = config.router_program @ BasketError::RouterNotAllowed)]\n',
    replace: '',
    fails: 'refuses any program but the router in Config',
  },
  {
    rule: 'owner_swap: the router is checked again before the vault signs',
    file: 'src/instructions/owner_swap.rs',
    find: '        check_router(accounts.router_program.key)?;\n',
    replace: '',
    fails: 'never calls the token program, even if Config named it',
  },
  {
    rule: 'owner_swap: the router is called for a route and nothing else',
    file: 'src/instructions/owner_swap.rs',
    find: '        check_route_selector(&data)?;\n',
    replace: '',
    fails: 'refuses an instruction of the router that is not a route',
  },
  {
    rule: 'owner_swap: one of the four route selectors',
    file: 'src/checks.rs',
    find: 'data.len() >= 8 && ROUTE_SELECTORS.iter().any(|s| s[..] == data[..8])',
    replace: 'data.len() >= 8',
    fails: 'refuses an instruction of the router that is not a route',
  },
  {
    rule: 'owner_swap: the output is on the platform list, or is cash',
    file: 'src/instructions/owner_swap.rs',
    find: / {8}require!\(\s+output_mint == accounts\.config\.cash_mint\s+\|\| accounts\.assets\.load\(\)\?\.is_listed\(&output_mint\),\s+BasketError::MintNotAccepted\s+\);\n/,
    replace: '',
    fails: 'refuses a token that is not on the platform list',
  },
  {
    rule: 'owner_swap: cash is always an allowed output',
    file: 'src/instructions/owner_swap.rs',
    find: /output_mint == accounts\.config\.cash_mint\s+\|\| /,
    replace: '',
    fails: 'sells back to cash',
  },
  {
    rule: 'owner_swap: no third token account of the vault goes to the router',
    file: 'src/instructions/owner_swap.rs',
    find: /(BasketError::MintNotAccepted\s+\);\n) {8}refuse_other_vault_accounts\([^;]+;\n/,
    replace: '$1',
    fails: 'cannot be given away, tokens and all',
  },
  {
    rule: 'owner_swap: no third token account of the vault comes back from the router',
    file: 'src/instructions/owner_swap.rs',
    find: /(let output_after = [^;]+;\n) {8}refuse_other_vault_accounts\([^;]+;\n/,
    replace: '$1',
    fails: 'cannot be made during the call and left with a delegate on it',
  },
  {
    rule: 'owner_swap: only a token program says what a token account is',
    file: 'src/checks.rs',
    find: / {4}if \*account\.owner != anchor_spl::token::ID && \*account\.owner != anchor_spl::token_2022::ID \{\s+return None;\s+\}\n/,
    replace: '',
    fails: 'only looks like a token account of the vault is not one',
  },
  {
    rule: "owner_swap: only the vault's signature goes to the router",
    file: 'src/instructions/owner_swap.rs',
    find: 'is_signer: *account.key == vault_key,',
    replace: 'is_signer: account.is_signer || *account.key == vault_key,',
    fails: "gets the vault's signature and nobody else's",
  },
  {
    rule: 'owner_swap: the vault account goes to the router read-only',
    file: 'src/instructions/owner_swap.rs',
    find: 'is_writable: account.is_writable && *account.key != vault_key,',
    replace: 'is_writable: account.is_writable,',
    fails: 'sees the vault as a read-only signer',
  },
  {
    rule: 'owner_swap: after the call, both accounts are still token accounts',
    file: 'src/checks.rs',
    find: 'return err!(BasketError::AccountTampered);',
    replace: 'return Ok(0);',
    fails: 'cannot close the account it emptied and keep its rent',
  },
  {
    rule: 'owner_swap: after the call, the vault still owns both accounts',
    file: 'src/checks.rs',
    find: requireLine('    ', 'after\\.owner == \\*vault'),
    replace: '',
    fails: 'cannot hand the account it spends from to someone else',
  },
  {
    rule: 'owner_swap: after the call, no delegate',
    file: 'src/checks.rs',
    find: requireLine('    ', '!after\\.has_delegate'),
    replace: '',
    fails: 'cannot leave a delegate on either',
  },
  {
    rule: 'owner_swap: after the call, no close authority',
    file: 'src/checks.rs',
    find: requireLine('    ', '!after\\.has_close_authority'),
    replace: '',
    fails: 'cannot leave a close authority on either',
  },
  {
    rule: 'owner_swap: after the call, the accounts are the size they were',
    file: 'src/checks.rs',
    find: requireLine('    ', 'after\\.data_len == before\\.data_len'),
    replace: '',
    fails: 'cannot change the size of either',
  },
  {
    rule: 'owner_swap: spent at most max_in',
    file: 'src/instructions/owner_swap.rs',
    find: requireLine('        ', 'spent <= max_in'),
    replace: '',
    fails: 'cannot take more than max_in',
  },
  {
    rule: 'owner_swap: received at least min_out',
    file: 'src/instructions/owner_swap.rs',
    find: requireLine('        ', 'received >= min_out'),
    replace: '',
    fails: 'cannot pay less than min_out',
  },
  {
    rule: 'owner_swap: the account that is paid into never ends with less',
    file: 'src/instructions/owner_swap.rs',
    find: /\.checked_sub\(output_before\.amount\)\s+\.ok_or\(BasketError::ReceivedTooLittle\)\?;/,
    replace: '.saturating_sub(output_before.amount);',
    fails: 'cannot take from the account it should pay into, even when min_out is zero',
  },
];

function build() {
  const result = spawnSync('anchor', BUILD, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`build failed:\n${result.stderr.slice(-3000)}`);
}

/** The suite's results: the full names of every test, and of those that failed. The suite's
 * global setup runs too, and leaves the binary alone: it was built a moment ago, so it is newer
 * than the edited source. */
function runSuite() {
  const out = join(mkdtempSync(join(tmpdir(), 'rules-bite-')), 'report.json');
  spawnSync('pnpm', ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${out}`], {
    cwd: HERE,
    encoding: 'utf8',
  });
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const tests = report.testResults.flatMap((file) => file.assertionResults);
  return {
    all: tests.map((t) => t.fullName),
    failed: tests.filter((t) => t.status === 'failed').map((t) => t.fullName),
  };
}

/** Where in the source an edit may be made: all of it, or the block that starts on the line
 * holding `within` and ends at the closing brace of the same indentation. */
function scope(source, within) {
  if (!within) return [0, source.length];
  const at = source.indexOf(within);
  if (at < 0 || source.indexOf(within, at + 1) >= 0)
    throw new Error(`"${within}" is not in the file exactly once`);
  const lineStart = source.lastIndexOf('\n', at) + 1;
  const indent = source.slice(lineStart, at).match(/^\s*/)[0];
  const close = source.indexOf(`\n${indent}}\n`, at);
  if (close < 0) throw new Error(`the block that starts at "${within}" does not end`);
  return [lineStart, close + indent.length + 3];
}

function occurrences(text, find) {
  if (typeof find === 'string') return text.split(find).length - 1;
  const flags = find.flags.includes('g') ? find.flags : `${find.flags}g`;
  return [...text.matchAll(new RegExp(find.source, flags))].length;
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const from = args.find((arg) => arg.startsWith('--from='))?.slice('--from='.length);
const filters = args.filter((arg) => !arg.startsWith('--'));
const start = from ? RULES.findIndex((r) => r.rule.includes(from)) : 0;
if (start < 0) throw new Error(`no rule matches "${from}"`);
const selected = RULES.slice(start).filter(
  (r) => !filters.length || filters.some((filter) => r.rule.includes(filter)),
);
for (const filter of filters)
  if (!selected.some((r) => r.rule.includes(filter)))
    throw new Error(`no rule matches "${filter}"`);

// A run that was killed outright leaves its one edit behind: nothing here runs on a SIGKILL.
// Building on top of that would test a program with a rule already missing.
const dirty = spawnSync('git', ['status', '--porcelain', '--', PROGRAM], { encoding: 'utf8' });
if (dirty.stdout.trim())
  throw new Error(
    `programs/basket has changes that are not committed:\n${dirty.stdout}Commit them, or put the files back if an earlier run was killed (git checkout -- programs/basket).`,
  );

let restore = () => {};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restore();
    process.exit(1);
  });
}

const baseline = runSuite();
if (baseline.failed.length) throw new Error('the suite must pass before any rule is removed');
// Every rule names a test that exists, and every edit finds its text, before anything is built.
for (const { rule, file, within, find, fails, cannotBite } of selected) {
  if (!cannotBite && !baseline.all.some((name) => name.includes(fails)))
    throw new Error(`${rule}: no test is named "${fails}"`);
  const source = readFileSync(join(PROGRAM, file), 'utf8');
  const [from, to] = scope(source, within);
  const matches = occurrences(source.slice(from, to), find);
  if (matches !== 1)
    throw new Error(`${rule}: the text to remove occurs ${matches} times in ${file}`);
}

if (checkOnly) {
  console.log(`${selected.length} rules: each names a test that exists and an edit that applies.`);
  process.exit(0);
}

const survivors = [];
let known = 0;
for (const { rule, file, within, find, replace, fails, cannotBite } of selected) {
  const path = join(PROGRAM, file);
  const original = readFileSync(path, 'utf8');
  const [from, to] = scope(original, within);
  restore = () => writeFileSync(path, original);
  try {
    writeFileSync(
      path,
      original.slice(0, from) +
        original.slice(from, to).replace(find, replace) +
        original.slice(to),
    );
    build();
    const { failed } = runSuite();
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
  } catch (error) {
    // An edit that no longer compiles is not a rule that bites: it is a row to repair.
    survivors.push(rule);
    console.log(`BROKEN    ${rule}`);
    console.log(`          ${String(error.message).split('\n').slice(0, 12).join('\n          ')}`);
  } finally {
    restore();
    restore = () => {};
  }
}

build();
if (runSuite().failed.length) throw new Error('the suite fails after the checks were put back');
const tested = selected.length - known;
console.log(`\n${tested - survivors.length} of ${tested} rules bite.`);
if (known) console.log(`${known} listed that no test in LiteSVM can notice.`);
if (survivors.length) {
  console.error(`No test noticed these being removed:\n  ${survivors.join('\n  ')}`);
  process.exit(1);
}
