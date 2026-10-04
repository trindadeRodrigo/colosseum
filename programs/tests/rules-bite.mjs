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
    within: 'pub struct UpsertAsset',
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
    ['args\\.flags & !ASSET_KEEPER == 0', 'a flag that has no meaning'],
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
    find: 'Ok(hook[32..TRANSFER_HOOK_LEN] != [0u8; 32])',
    replace: 'Ok(false)',
    fails: 'refuses a hook program that sits after pausable in the mint',
  },
  {
    rule: 'hook list: an entry cut off inside its header is refused',
    file: 'src/checks.rs',
    find: '        if at + 4 > data.len() {\n            return Err(malformed.into());\n        }\n',
    replace: '',
    fails: 'is refused when the list is cut off inside an entry',
  },
  {
    rule: 'hook list: an entry longer than the mint is refused',
    file: 'src/checks.rs',
    find: '        if value + length > data.len() {\n            return Err(malformed.into());\n        }\n',
    replace: '',
    fails: 'is refused when an entry says it is longer than the mint',
  },
  {
    rule: 'hook list: a hook entry too short to hold a program is refused',
    file: 'src/checks.rs',
    find: requireLine('    ', 'hook\\.len\\(\\) >= TRANSFER_HOOK_LEN'),
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

  {
    rule: 'upsert_asset: a price range has its ceiling above its floor',
    file: 'src/instructions/assets.rs',
    find: requireLine('            ', 'args\\.min_price < args\\.max_price'),
    replace: '',
    fails: 'needs a ceiling above its floor',
  },
  {
    rule: 'upsert_asset: the ceiling of a range is at most twice its floor',
    file: 'src/instructions/assets.rs',
    find: requireLine(
      '            ',
      'args\\.max_price <= args\\.min_price\\.saturating_mul\\(MAX_PRICE_RANGE_RATIO\\)',
    ),
    replace: '',
    fails: 'is no wider than a ceiling of twice the floor',
  },
  {
    rule: 'upsert_asset: twice the largest floor is still a ceiling',
    file: 'src/instructions/assets.rs',
    find: 'args.min_price.saturating_mul(MAX_PRICE_RANGE_RATIO)',
    replace: 'args.min_price.wrapping_mul(MAX_PRICE_RANGE_RATIO)',
    fails: 'is no wider than a ceiling of twice the floor',
  },
  {
    rule: 'upsert_asset: an asset the keeper does not trade needs no range',
    file: 'src/instructions/assets.rs',
    find: 'if args.min_price != 0 || args.max_price != 0 {',
    replace: 'if true {',
    fails: 'may be left out on an asset the keeper does not trade',
  },
  {
    rule: "upsert_asset: the keeper's switch needs a price range",
    file: 'src/instructions/assets.rs',
    find: requireLine('        ', 'args\\.flags & ASSET_KEEPER == 0 \\|\\| args\\.max_price != 0'),
    replace: '',
    fails: 'stays off for an asset with no price range',
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

  // ---- the keeper slot: the admin's and the guardian's setters ----
  {
    rule: 'set_guardian: the zero address is refused',
    file: 'src/instructions/config.rs',
    within: 'pub fn set_guardian',
    find: '        check_address(&guardian)?;\n',
    replace: '',
    fails: 'set_guardian refuses the zero address',
  },
  {
    rule: 'set_default_keeper: the zero address is refused',
    file: 'src/instructions/config.rs',
    within: 'pub fn set_default_keeper',
    find: '        check_address(&keeper)?;\n',
    replace: '',
    fails: 'set_default_keeper refuses the zero address',
  },
  {
    rule: 'extend_closed_until: the guardian only pushes it later',
    file: 'src/instructions/config.rs',
    find: requireLine('        ', 'closed_until > config\\.closed_until'),
    replace: '',
    fails: 'does not let the guardian bring it earlier, or leave it where it is',
  },
  {
    rule: 'closed days: day zero cannot be closed',
    file: 'src/state.rs',
    within: 'pub fn close_day',
    find: requireLine('        ', 'day != 0'),
    replace: '',
    fails: 'refuses day zero, which marks an empty slot',
  },
  {
    rule: 'closed days: day zero cannot be opened',
    file: 'src/state.rs',
    within: 'pub fn open_day',
    find: requireLine('        ', 'day != 0'),
    replace: '',
    fails: 'refuses day zero, which marks an empty slot',
  },
  {
    rule: 'closed days: a day is kept once',
    file: 'src/state.rs',
    find: '        if self.closed_days.contains(&day) {\n            return Ok(());\n        }\n',
    replace: '',
    fails: 'keeps a day once: closing it twice takes one slot',
  },
  {
    rule: 'closed days: a full list takes no more',
    file: 'src/state.rs',
    find: '.find(|slot| **slot == 0)',
    replace: '.next()',
    fails: 'holds 32 days and refuses a 33rd, until one is opened',
  },
  {
    rule: 'set_price_account: the admin signs',
    file: 'src/instructions/assets.rs',
    within: 'pub struct SetPriceAccount',
    find: SIGNER('admin'),
    replace: UNSIGNED('admin'),
    fails: 'set_price_account is the admin alone',
  },
  {
    rule: 'set_price_account: the signer is the admin',
    file: 'src/instructions/assets.rs',
    within: 'pub struct SetPriceAccount',
    find: hasOne('admin'),
    replace: 'bump = config.bump',
    fails: 'set_price_account is the admin alone',
  },
  {
    rule: 'set_price_account: Config is the one at its own address',
    file: 'src/instructions/assets.rs',
    within: 'pub struct SetPriceAccount',
    find: pinnedWith('admin'),
    replace: 'has_one = admin',
    fails: 'set_price_account writes only the real list, on the word of the real Config only',
  },
  {
    rule: 'set_price_account: the asset list is the one at its own address',
    file: 'src/instructions/assets.rs',
    within: 'pub struct SetPriceAccount',
    find: /mut,\s+seeds = \[ASSETS_SEED\],\s+bump/,
    replace: 'mut',
    fails: 'set_price_account writes only the real list, on the word of the real Config only',
  },
  {
    rule: 'set_price_account: the account is owned by the price program',
    file: 'src/instructions/assets.rs',
    find: /owner = config\.price_owner @ BasketError::AssetNotPriced,\s+constraint/,
    replace: 'constraint',
    fails: 'refuses an account the price program does not own',
  },
  {
    rule: 'set_price_account: the account is the size of a price account',
    file: 'src/instructions/assets.rs',
    find: /,\s+constraint = price_account\.data_len\(\) == PRICES_LEN @ BasketError::AssetNotPriced/,
    replace: '',
    fails: 'refuses an account that is not the size of a price account',
  },
  {
    rule: 'set_price_account: locked at launch',
    file: 'src/instructions/assets.rs',
    find: requireLine('        ', '!ctx\\.accounts\\.config\\.launched'),
    replace: '',
    fails: 'is locked at launch, like the price program',
  },
  {
    rule: 'set_price_account: one of the four slots',
    file: 'src/instructions/assets.rs',
    within: 'impl SetPriceAccount',
    find: requireLine('        ', '\\(slot as usize\\) < MAX_PRICE_ACCOUNTS'),
    replace: '',
    fails: 'set_price_account refuses a slot past the four',
  },
  {
    rule: "upsert_asset: the keeper's switch needs a price entry",
    file: 'src/instructions/assets.rs',
    find: '(args.price_kind == 1 && args.twap_index != args.price_index)',
    replace: '(args.twap_index != args.price_index)',
    fails: 'stays off for an asset with no price entry',
  },
  {
    rule: "upsert_asset: the keeper's switch needs an average of its own",
    file: 'src/instructions/assets.rs',
    find: '(args.price_kind == 1 && args.twap_index != args.price_index)',
    replace: '(args.price_kind == 1)',
    fails: 'stays off when the average is the price entry itself',
  },
  {
    rule: 'cancel_pending: the number of the version taken back is spent',
    file: 'src/instructions/recipe.rs',
    find: '        recipe.last_version = recipe.last_version.max(recipe.pending.version);\n',
    replace: '',
    fails: 'a cancel on such a portfolio spends the number of the version it takes back',
  },

  // ---- accept, adopt, auto-follow ----
  {
    rule: 'accept_version: the owner signs',
    file: 'src/instructions/follow.rs',
    within: 'pub struct AcceptVersion',
    find: SIGNER('owner'),
    replace: UNSIGNED('owner'),
    fails: 'accept_version is the owner alone',
  },
  {
    rule: 'accept_version: the signer is the vault owner',
    file: 'src/instructions/follow.rs',
    within: 'pub struct AcceptVersion',
    find: '#[account(mut, has_one = owner)]',
    replace: '#[account(mut)]',
    fails: 'accept_version is the owner alone',
  },
  {
    rule: 'accept_version: the version that waits is not in effect',
    file: 'src/instructions/follow.rs',
    find: requireLine(
      '        ',
      '!\\(recipe\\.has_pending\\(now\\) && recipe\\.pending\\.version == expected_version\\)',
    ),
    replace: '',
    fails: 'refuses the version that waits: it is not in effect yet',
  },
  {
    rule: 'accept_version: the number is that of the version in effect',
    file: 'src/instructions/follow.rs',
    find: requireLine('        ', 'expected_version == active\\.version'),
    replace: '',
    fails: 'refuses any number but that of the version in effect',
  },
  {
    rule: 'a version and what is left over fit 16 lines',
    file: 'src/state.rs',
    find: requireLine('        ', 'next\\.len\\(\\) <= MAX_POSITIONS'),
    replace: '',
    fails: 'refuses when the version and what is left over do not fit 16 lines',
  },
  {
    rule: 'a dropped asset the vault still holds stays as a position',
    file: 'src/state.rs',
    find: '                next.push((held.mint, 0));\n',
    replace: '',
    fails: 'keeps the asset as a position with no target while the vault still holds it',
  },
  {
    rule: 'a dropped asset the vault holds nothing of goes',
    file: 'src/state.rs',
    find: '.iter().filter(|p| p.tracked > 0)',
    replace: '.iter()',
    fails: 'lets the asset go when the vault holds nothing of it',
  },
  {
    rule: 'adopt_version: only the portfolio the vault follows',
    file: 'src/instructions/follow.rs',
    find: '    #[account(address = vault.recipe)]\n',
    replace: '',
    fails: 'takes only the portfolio the vault follows',
  },
  {
    rule: 'adopt_version: Config is the one at its own address',
    file: 'src/instructions/follow.rs',
    find: CONFIG_PINNED,
    replace: '',
    fails: 'reads the pause from the real Config only',
  },
  {
    rule: 'adopt_version: auto-follow is on',
    file: 'src/instructions/follow.rs',
    find: requireLine('        ', 'vault\\.auto_follow'),
    replace: '',
    fails: 'adopt_version refuses while auto-follow is off',
  },
  {
    rule: 'adopt_version: not while the keeper is paused',
    file: 'src/instructions/follow.rs',
    find: requireLine('        ', '!ctx\\.accounts\\.config\\.keeper_paused'),
    replace: '',
    fails: 'adopt_version refuses while the keeper is paused',
  },
  {
    rule: 'adopt_version: only a version newer than the one the vault holds',
    file: 'src/instructions/follow.rs',
    find: requireLine('        ', 'active\\.version > vault\\.accepted_version'),
    replace: '',
    fails: 'refuses when nothing newer is in effect',
  },
  {
    rule: 'adopt_version: no asset the owner has not accepted',
    file: 'src/instructions/follow.rs',
    find: requireLine(
      '        ',
      'active\\.components\\(\\)\\.iter\\(\\)\\.all\\(\\|c\\| vault\\.accepts\\(&c\\.mint\\)\\)',
    ),
    replace: '',
    fails: 'leaves a version with a new asset to the owner',
  },
  {
    rule: 'holding an asset is not accepting it',
    file: 'src/state.rs',
    find: '.is_some_and(|p| p.target_bps > 0)',
    replace: '.is_some()',
    fails: 'counts an asset the vault only holds leftovers of as new',
  },
  {
    rule: 'set_auto_follow: the owner signs',
    file: 'src/instructions/follow.rs',
    within: 'pub struct SetAutoFollow',
    find: SIGNER('owner'),
    replace: UNSIGNED('owner'),
    fails: 'set_auto_follow is the owner alone',
  },
  {
    rule: 'set_auto_follow: the signer is the vault owner',
    file: 'src/instructions/follow.rs',
    within: 'pub struct SetAutoFollow',
    find: '#[account(mut, has_one = owner)]',
    replace: '#[account(mut)]',
    fails: 'set_auto_follow is the owner alone',
  },

  // ---- sync_balances ----
  {
    rule: 'sync_balances: the owner or the keeper signs',
    file: 'src/instructions/sync_balances.rs',
    find: SIGNER('signer'),
    replace: UNSIGNED('signer'),
    fails: 'sync_balances needs that key to sign',
  },
  {
    rule: 'sync_balances: nobody but the owner and the keeper',
    file: 'src/instructions/sync_balances.rs',
    find: '            check_keeper(&signer, &ctx.accounts.vault, &ctx.accounts.config)?;\n',
    replace: '',
    fails: 'is not for anyone else: not the guardian, the admin or a stranger',
  },
  {
    rule: 'sync_balances: the owner may, keeper or not',
    file: 'src/instructions/sync_balances.rs',
    find: 'if signer != ctx.accounts.vault.owner {',
    replace: 'if true {',
    fails: "records what the vault's own token accounts hold, for its owner or its keeper",
  },
  {
    rule: 'sync_balances: the keeper is read from the real Config',
    file: 'src/instructions/sync_balances.rs',
    find: CONFIG_PINNED,
    replace: '',
    fails: 'sync_balances refuses a forged Config that names the signer as keeper',
  },
  {
    rule: 'sync_balances: an account that is not a token account is refused, not passed over',
    file: 'src/instructions/sync_balances.rs',
    find: 'let token = token_view(account).ok_or(BasketError::AccountTampered)?;',
    replace: 'let Some(token) = token_view(account) else { continue };',
    fails: 'reads only the one token account the vault uses for a mint',
  },
  {
    rule: 'sync_balances: the token account belongs to the vault',
    file: 'src/instructions/sync_balances.rs',
    find: requireLine('            ', 'token\\.owner == vault_key'),
    replace: '',
    fails: "records nothing from that account once it is no longer the vault's",
  },
  {
    rule: "sync_balances: the token account is the vault's one account for the mint",
    file: 'src/instructions/sync_balances.rs',
    find: requireLine('            ', 'own == \\*account\\.key'),
    replace: '',
    fails: 'reads only the one token account the vault uses for a mint',
  },
  {
    rule: 'sync_balances: the mint is one of the positions',
    file: 'src/instructions/sync_balances.rs',
    find: requireLine(
      '            ',
      'ctx\\.accounts\\.vault\\.position\\(&token\\.mint\\)\\.is_some\\(\\)',
    ),
    replace: '',
    fails: 'records nothing for a mint that is not one of the positions',
  },

  // ---- keeper_leg: who, and which accounts ----
  {
    rule: 'keeper_leg: the keeper signs',
    file: 'src/instructions/keeper_leg.rs',
    find: SIGNER('keeper'),
    replace: UNSIGNED('keeper'),
    fails: 'keeper_leg who may call it needs the keeper to sign',
  },
  {
    rule: 'keeper_leg: the signer is the keeper',
    file: 'src/instructions/keeper_leg.rs',
    find: '        check_keeper(self.keeper.key, &self.vault, &self.config)?;\n',
    replace: '',
    fails: 'is the keeper alone: not the owner, the guardian, the admin or anyone else',
  },
  {
    rule: 'keeper: the signer is compared with the keeper',
    file: 'src/checks.rs',
    find: requireLine('    ', '\\*signer == keeper'),
    replace: '',
    fails: 'is the keeper alone: not the owner, the guardian, the admin or anyone else',
  },
  {
    rule: "keeper: a vault's own keeper comes before Config's",
    file: 'src/checks.rs',
    find: /let keeper = if vault\.keeper == Pubkey::default\(\) \{\s+config\.default_keeper\s+\} else \{\s+vault\.keeper\s+\};/,
    replace: 'let keeper = config.default_keeper;',
    fails: 'is the keeper the vault names, when it names one',
  },
  {
    rule: 'keeper_leg: Config is the one at its own address',
    file: 'src/instructions/keeper_leg.rs',
    find: CONFIG_PINNED,
    replace: '',
    fails: 'refuses a forged Config that names the signer as keeper',
  },
  {
    rule: 'keeper_leg: the asset list is the one at its own address',
    file: 'src/instructions/keeper_leg.rs',
    find: ASSETS_PINNED,
    replace: '',
    fails: 'reads the asset list at its own address only',
  },
  {
    rule: "keeper_leg: the input's token program is the mint's own",
    file: 'src/instructions/keeper_leg.rs',
    find: '    #[account(mint::token_program = input_token_program)]\n',
    replace: '',
    fails: 'keeper_leg what it may trade refuses a token program',
  },
  {
    rule: "keeper_leg: the output's token program is the mint's own",
    file: 'src/instructions/keeper_leg.rs',
    find: '    #[account(mint::token_program = output_token_program)]\n',
    replace: '',
    fails: 'keeper_leg what it may trade refuses a token program',
  },
  {
    rule: "keeper_leg: spends only from the vault's associated token account",
    file: 'src/instructions/keeper_leg.rs',
    find: associated('input'),
    replace: 'mut',
    fails: "keeper_leg what it may trade spends only from, and pays only into, the vault's",
  },
  {
    rule: "keeper_leg: pays only into the vault's associated token account",
    file: 'src/instructions/keeper_leg.rs',
    find: associated('output'),
    replace: 'mut',
    fails: "keeper_leg what it may trade spends only from, and pays only into, the vault's",
  },
  {
    rule: 'keeper_leg: the program called is the router in Config',
    file: 'src/instructions/keeper_leg.rs',
    find: '    #[account(address = config.router_program @ BasketError::RouterNotAllowed)]\n',
    replace: '',
    fails: 'keeper_leg through a hostile router takes only the router Config names',
  },
  {
    rule: 'keeper_leg: the price account is owned by the price program',
    file: 'src/instructions/keeper_leg.rs',
    find: '    #[account(owner = config.price_owner @ BasketError::AssetNotPriced)]\n',
    replace: '',
    fails: 'is owned by the price program Config names',
  },
  {
    rule: 'keeper_leg: auto-follow is on',
    file: 'src/instructions/keeper_leg.rs',
    find: requireLine('        ', 'self\\.vault\\.auto_follow'),
    replace: '',
    fails: 'keeper_leg who may call it refuses while auto-follow is off',
  },
  {
    rule: 'keeper_leg: not while the keeper is paused',
    file: 'src/instructions/keeper_leg.rs',
    find: requireLine('        ', '!self\\.config\\.keeper_paused'),
    replace: '',
    fails: 'stops the keeper and never the owner',
  },
  {
    rule: 'keeper_leg: cash on exactly one side',
    file: 'src/instructions/keeper_leg.rs',
    find: requireLine('        ', 'input_is_cash != output_is_cash'),
    replace: '',
    fails: 'trades cash for an asset or an asset for cash, never one asset for another',
  },
  {
    rule: "keeper_leg: the asset is one of the vault's positions",
    file: 'src/instructions/keeper_leg.rs',
    find: /\.position\(&asset_mint\)\s+\.ok_or/,
    replace: '.position(&asset_mint).or(self.vault.positions.first()).ok_or',
    fails: 'refuses a token that is not one of the positions, listed or not',
  },

  {
    rule: 'keeper_leg: the asset is on the asset list',
    file: 'src/instructions/keeper_leg.rs',
    find: /\.find\(&asset_mint\)\s+\.ok_or\(BasketError::MintNotAccepted\)\?;/,
    replace: '.find(&asset_mint).or(registry.assets.first()).ok_or(BasketError::MintNotAccepted)?;',
    fails: 'refuses an asset that is not on the asset list, position or not',
  },

  // ---- keeper_leg: the asset's mint, the market, the cooldown ----
  {
    rule: 'keeper_leg: the mint of the asset is checked',
    file: 'src/instructions/keeper_leg.rs',
    find: '        check_keeper_mint(&asset.to_account_info(), now)?;\n',
    replace: '',
    fails: 'refuses an asset whose issuer gave it a transfer hook program',
  },
  {
    rule: 'keeper mint: no transfer hook program',
    file: 'src/checks.rs',
    find: requireLine('    ', '!mint_has_hook_program\\(&data\\)\\?'),
    replace: '',
    fails: 'refuses an asset whose issuer gave it a transfer hook program',
  },
  {
    rule: 'keeper mint: not around a multiplier change',
    file: 'src/checks.rs',
    find: requireLine('    ', '!mint_in_multiplier_window\\(&data, now\\)\\?'),
    replace: '',
    fails: 'refuses a stock within a day before its multiplier changes',
  },
  {
    rule: 'multiplier: the day before a change',
    file: 'src/checks.rs',
    find: 'now.saturating_sub(changes_at).saturating_abs() < MULTIPLIER_WINDOW_S',
    replace: '(now >= changes_at && now.saturating_sub(changes_at) < MULTIPLIER_WINDOW_S)',
    fails: 'refuses a stock within a day before its multiplier changes',
  },
  {
    rule: 'multiplier: the day after a change',
    file: 'src/checks.rs',
    find: 'now.saturating_sub(changes_at).saturating_abs() < MULTIPLIER_WINDOW_S',
    replace: '(changes_at >= now && changes_at.saturating_sub(now) < MULTIPLIER_WINDOW_S)',
    fails: 'refuses a stock within a day after its multiplier changed',
  },
  {
    rule: 'multiplier: the same multiplier again is no change',
    file: 'src/checks.rs',
    find: 'Ok(changes && now',
    replace: 'Ok(now',
    fails: 'takes a mint whose next multiplier is the one it has: nothing changes',
  },
  {
    rule: 'multiplier: an entry too short to read is refused',
    file: 'src/checks.rs',
    find: requireLine('    ', 'scaled\\.len\\(\\) >= SCALED_UI_AMOUNT_LEN'),
    replace: '',
    fails: 'refuses a mint whose multiplier cannot be read',
  },
  {
    rule: 'keeper_leg: the market of the asset is open',
    file: 'src/instructions/keeper_leg.rs',
    find: '        check_market(entry.session, &self.config, now)?;\n',
    replace: '',
    fails: 'refuses a stock on Saturday and on Sunday, with a feed that looks fresh',
  },
  {
    rule: 'market: a stock is held to the session',
    file: 'src/checks.rs',
    find: requireLine('    ', 'session == 0 \\|\\| market_open\\(config, now\\)'),
    replace: '',
    fails: 'refuses a stock on Saturday and on Sunday, with a feed that looks fresh',
  },
  {
    rule: 'market: an asset with no session trades at any hour',
    file: 'src/checks.rs',
    find: 'session == 0 || market_open(config, now)',
    replace: 'market_open(config, now)',
    fails: 'trades an asset that has no session at any hour',
  },
  {
    rule: 'market: Monday to Friday',
    file: 'src/checks.rs',
    find: '(1..=5).contains(&weekday)',
    replace: 'true',
    fails: 'refuses a stock on Saturday and on Sunday, with a feed that looks fresh',
  },
  {
    rule: 'market: not before the open',
    file: 'src/checks.rs',
    find: 'second >= config.session_open_utc_s as i64',
    replace: 'true',
    fails: 'refuses a stock one minute before the open, and takes it at the open',
  },
  {
    rule: 'market: not at or after the close',
    file: 'src/checks.rs',
    find: 'second < config.session_close_utc_s as i64',
    replace: 'true',
    fails: 'takes a stock in the last second of the session and refuses it at the close',
  },
  {
    rule: 'market: not on a closed day',
    file: 'src/checks.rs',
    find: 'in_session && !closed_day && now >= config.closed_until',
    replace: 'in_session && now >= config.closed_until',
    fails: 'refuses a stock on a closed day, with a feed that looks fresh',
  },
  {
    rule: 'market: an empty slot of the closed days is not a day',
    file: 'src/checks.rs',
    find: 'let closed_day = day > 0 && ',
    replace: 'let closed_day = ',
    fails: 'does not take an empty slot of the closed days for a day',
  },
  {
    rule: 'market: not before closed_until',
    file: 'src/checks.rs',
    find: 'in_session && !closed_day && now >= config.closed_until',
    replace: 'in_session && !closed_day',
    fails: 'refuses a stock before the time the market is closed until',
  },
  {
    rule: 'keeper_leg: the cooldown of the asset is checked',
    file: 'src/instructions/keeper_leg.rs',
    find: '        check_cooldown(position.last_keeper_ts, self.config.asset_cooldown_s, now)?;\n',
    replace: '',
    fails: 'allows one trade per asset per cooldown',
  },
  {
    rule: 'cooldown: one trade per asset per cooldown',
    file: 'src/checks.rs',
    find: requireLine('    ', 'now >= last_keeper_ts\\.saturating_add\\(cooldown_s as i64\\)'),
    replace: '',
    fails: 'allows one trade per asset per cooldown',
  },
  {
    rule: 'keeper_leg: the time of the trade is stamped on the asset',
    file: 'src/instructions/keeper_leg.rs',
    find: '        vault.stamp_keeper(&before.asset_mint, now);\n',
    replace: '',
    fails: 'allows one trade per asset per cooldown',
  },

  // ---- keeper_leg: the price reference ----
  {
    rule: 'price: the asset has a price entry',
    file: 'src/price.rs',
    find: requireLine('    ', 'entry\\.price_kind == 1'),
    replace: '',
    fails: 'refuses an asset with no price entry',
  },
  {
    rule: 'price: the admin has switched the asset on for the keeper',
    file: 'src/price.rs',
    find: requireLine('    ', 'entry\\.keeper_on\\(\\)'),
    replace: '',
    fails: 'refuses an asset the admin has not switched on',
  },
  {
    rule: 'price: an asset that asks for a check of its source is not traded',
    file: 'src/price.rs',
    find: requireLine('    ', 'source_check == \\[0u8; 32\\]'),
    replace: '',
    fails: 'refuses an asset that asks for a check of its source',
  },
  {
    rule: 'price: the account is the one the asset list names',
    file: 'src/price.rs',
    find: requireLine('    ', 'pinned == \\*prices_key'),
    replace: '',
    fails: 'is the one the asset list names for the asset',
  },
  {
    rule: 'price: the account is the size of a price account',
    file: 'src/price.rs',
    find: requireLine('    ', 'data\\.len\\(\\) == PRICES_LEN'),
    replace: '',
    fails: 'refuses a price account that is no longer the size of one',
  },
  {
    rule: 'price: an entry with no value is not a price',
    file: 'src/price.rs',
    find: requireLine('    ', 'value > 0'),
    replace: '',
    fails: 'holds a price at the entry: one nobody wrote is refused',
  },
  {
    rule: 'price: an entry with no time is not a price',
    file: 'src/price.rs',
    find: requireLine('    ', 'unix_timestamp > 0'),
    replace: '',
    fails: 'holds a price at the entry: one nobody wrote is refused',
  },
  {
    rule: 'price: a time past what a clock holds is not a price',
    file: 'src/price.rs',
    find: requireLine('    ', 'unix_timestamp <= i64::MAX as u64'),
    replace: '',
    fails: 'refuses a time no clock can hold',
  },
  {
    rule: 'price: an absurd exponent is not a price',
    file: 'src/price.rs',
    find: requireLine('    ', 'exponent <= MAX_PRICE_EXPONENT'),
    replace: '',
    fails: 'refuses an exponent no price has',
  },
  {
    rule: 'price: the price is fresh',
    file: 'src/price.rs',
    find: '    check_fresh(price.unix_timestamp, now, config.max_price_age_s as i64)?;\n',
    replace: '',
    fails: 'refuses a price older than the allowed age',
  },
  {
    rule: 'price: the average is no older than an hour',
    file: 'src/price.rs',
    find: '    check_fresh(twap.unix_timestamp, now, MAX_TWAP_AGE_S)?;\n',
    replace: '',
    fails: 'refuses an average more than an hour old',
  },
  {
    rule: 'price: not older than the allowed age',
    file: 'src/price.rs',
    find: requireLine('    ', 'age <= max_age_s'),
    replace: '',
    fails: 'refuses a price older than the allowed age',
  },
  {
    rule: 'price: not stamped further ahead than the allowed age',
    file: 'src/price.rs',
    find: requireLine('    ', 'age >= -max_age_s'),
    replace: '',
    fails: 'refuses a price stamped further ahead of the clock than that',
  },
  {
    rule: 'price: the price is held to its average',
    file: 'src/price.rs',
    find: '    check_deviation(&price, &twap, config.twap_dev_bps)?;\n',
    replace: '',
    fails: 'refuses a price too far under its average',
  },
  {
    rule: 'price: within the allowed distance of its average',
    file: 'src/price.rs',
    find: '.is_some_and(|(distance, allowed)| distance <= allowed)',
    replace: '.is_some()',
    fails: 'refuses a price too far under its average',
  },
  {
    rule: 'price: a price under its average is measured too',
    file: 'src/price.rs',
    find: /let within = spot\s+\.abs_diff\(average\)/,
    replace: 'let within = spot.saturating_sub(average)',
    fails: 'refuses a price too far under its average',
  },
  {
    rule: 'price: a price over its average is measured too',
    file: 'src/price.rs',
    find: /let within = spot\s+\.abs_diff\(average\)/,
    replace: 'let within = average.saturating_sub(spot)',
    fails: 'refuses a price too far over its average',
  },
  {
    rule: 'price: the average is read from the entry the asset names for it',
    file: 'src/price.rs',
    find: 'read_entry(prices, entry.twap_index)?',
    replace: 'read_entry(prices, entry.price_index)?',
    fails: 'refuses a price too far under its average',
  },
  {
    rule: 'price: an average too far from the price to compare is refused',
    file: 'src/price.rs',
    find: '.is_some_and(|(distance, allowed)| distance <= allowed)',
    replace: '.map_or(true, |(distance, allowed)| distance <= allowed)',
    fails: 'refuses an average so far from the price that the two cannot be compared',
  },
  {
    rule: "price: the price is held to the asset's range",
    file: 'src/price.rs',
    find: '    check_range(&price, entry.min_price, entry.max_price)?;\n',
    replace: '',
    fails: 'refuses a price and its average that are both twice the pool price',
  },
  {
    rule: 'range: no price under the floor',
    file: 'src/price.rs',
    find: requireLine('    ', 'scaled >= \\(min_price as u128\\) \\* unit'),
    replace: '',
    fails: 'takes a price at the floor and at the ceiling, and none past either',
  },
  {
    rule: 'range: no price over the ceiling',
    file: 'src/price.rs',
    find: requireLine('    ', 'scaled <= \\(max_price as u128\\) \\* unit'),
    replace: '',
    fails: 'takes a price at the floor and at the ceiling, and none past either',
  },
  {
    rule: "range: read against the price's own number of decimal places",
    file: 'src/price.rs',
    find: 'let unit = 10u128.pow(price.exponent);',
    replace: 'let unit = 10u128.pow(8);',
    fails: 'reads the range against a price with another number of decimal places',
  },
  {
    rule: 'valuation: a position that is not on the asset list stops the leg',
    file: 'src/price.rs',
    find: /let entry = registry\s+\.find\(&position\.mint\)\s+\.ok_or\(BasketError::AssetNotPriced\)\?;/,
    replace: 'let Some(entry) = registry.find(&position.mint) else { continue };',
    fails: 'refuses a leg in a vault that holds an asset that is not on the asset list',
  },
  {
    rule: 'valuation: every position the vault holds something of is held to its reference',
    file: 'src/price.rs',
    find: 'let price = reference(prices, prices_key, registry, entry, config, now)?;',
    replace:
      'let price = read_entry(prices, entry.price_index).map(|p| Reference { value: p.value, exponent: p.exponent })?;',
    fails: 'holds every asset the vault has something of to it, not only the one traded',
  },
  {
    rule: 'valuation: a vault past the largest value is refused',
    file: 'src/price.rs',
    find: requireLine('    ', 'total <= MAX_VAULT_VALUE'),
    replace: '',
    fails: 'is refused before the trade, and one at exactly that value is traded',
  },
  {
    rule: 'valuation: what the vault holds of its other positions counts',
    file: 'src/price.rs',
    within: 'pub fn value_of_others(',
    find: '    Ok(total)\n',
    replace: '    Ok(0)\n',
    fails: 'counts what the vault holds of its other positions in the weight',
  },
  {
    rule: 'valuation: the asset that is traded is not counted twice',
    file: 'src/price.rs',
    find: 'if position.mint == *except || position.tracked == 0 {',
    replace: 'if position.tracked == 0 {',
    fails: 'sells an asset that is over its target for cash',
  },
  {
    rule: 'valuation: an asset the vault holds nothing of needs no price',
    file: 'src/price.rs',
    find: 'if position.mint == *except || position.tracked == 0 {',
    replace: 'if position.mint == *except {',
    fails: 'does not mind an asset that is switched off when the vault holds nothing of it',
  },

  // ---- keeper_leg: around the router's call ----
  {
    rule: 'keeper_leg: the router is checked again before the vault signs',
    file: 'src/instructions/keeper_leg.rs',
    find: '        check_router(accounts.router_program.key)?;\n',
    replace: '',
    fails: 'keeper_leg through a hostile router never calls the token program',
  },
  {
    rule: 'keeper_leg: the router is called for a route and nothing else',
    file: 'src/instructions/keeper_leg.rs',
    find: '        check_route_selector(&data)?;\n',
    replace: '',
    fails: 'takes only a swap: any other instruction of the router is refused',
  },
  {
    rule: 'keeper_leg: no third token account of the vault goes to the router',
    file: 'src/instructions/keeper_leg.rs',
    find: /(check_route_selector\(&data\)\?;\n) {8}refuse_other_vault_accounts\([^;]+;\n/,
    replace: '$1',
    fails:
      'keeper_leg through a hostile router any other token account of the vault cannot be given away',
  },
  {
    rule: 'keeper_leg: no third token account of the vault comes back from the router',
    file: 'src/instructions/keeper_leg.rs',
    find: /(let output_after = [^;]+;\n) {8}refuse_other_vault_accounts\([^;]+;\n/,
    replace: '$1',
    fails:
      'keeper_leg through a hostile router any other token account of the vault cannot be made during the call',
  },
  {
    rule: "keeper_leg: only the vault's signature goes to the router",
    file: 'src/instructions/keeper_leg.rs',
    find: 'is_signer: *account.key == vault_key,',
    replace: 'is_signer: account.is_signer || *account.key == vault_key,',
    fails:
      "keeper_leg through a hostile router the signatures it is handed gets the vault's signature",
  },
  {
    rule: 'keeper_leg: the vault account goes to the router read-only',
    file: 'src/instructions/keeper_leg.rs',
    find: 'is_writable: account.is_writable && *account.key != vault_key,',
    replace: 'is_writable: account.is_writable,',
    fails:
      'keeper_leg through a hostile router the signatures it is handed sees the vault as a read-only signer',
  },
  {
    rule: 'keeper_leg: after the call, the account it spent from is as it was',
    file: 'src/instructions/keeper_leg.rs',
    find: 'let input_after = check_untampered(&input_info, &input_before, &vault_key)?;',
    replace:
      'let input_after = token_view(&input_info).ok_or(BasketError::AccountTampered)?.amount;',
    fails:
      "keeper_leg through a hostile router the vault's two token accounts after the call cannot leave a delegate",
  },
  {
    rule: 'keeper_leg: after the call, the account it was paid into is as it was',
    file: 'src/instructions/keeper_leg.rs',
    find: 'let output_after = check_untampered(&output_info, &output_before, &vault_key)?;',
    replace:
      'let output_after = token_view(&output_info).ok_or(BasketError::AccountTampered)?.amount;',
    fails:
      "keeper_leg through a hostile router the vault's two token accounts after the call cannot leave a delegate",
  },
  {
    rule: 'keeper_leg: spent at most what the keeper said',
    file: 'src/instructions/keeper_leg.rs',
    find: requireLine('        ', 'spent <= amount_in'),
    replace: '',
    fails: 'keeper_leg through a hostile router the balances cannot take more than the keeper said',
  },
  {
    rule: 'keeper_leg: the account that is paid into never ends with less',
    file: 'src/instructions/keeper_leg.rs',
    find: /\.checked_sub\(output_before\.amount\)\s+\.ok_or\(BasketError::ReceivedTooLittle\)\?;/,
    replace: '.saturating_sub(output_before.amount);',
    fails:
      'keeper_leg through a hostile router the balances cannot take from the account it should pay into',
  },

  // ---- keeper_leg: value, direction, the loss cap ----
  {
    rule: 'keeper_leg: the trade is held to the reference price',
    file: 'src/instructions/keeper_leg.rs',
    find: '        check_value(spent_value, received_value, accounts.config.tolerance_bps)?;\n',
    replace: '',
    fails: 'refuses a purchase at a price worse than the tolerance',
  },
  {
    rule: 'value: what came in is worth what went out, less the tolerance',
    file: 'src/checks.rs',
    find: 'received_value * BPS as u128 >= floor',
    replace: 'true',
    fails: 'refuses a purchase at a price worse than the tolerance',
  },
  {
    rule: 'value: the tolerance is allowed',
    file: 'src/checks.rs',
    find: '(BPS as u128).saturating_sub(tolerance_bps as u128)',
    replace: '(BPS as u128)',
    fails: 'takes a purchase at exactly the tolerance, and counts what it lost',
  },
  {
    rule: 'keeper_leg: the trade moves toward the target',
    file: 'src/instructions/keeper_leg.rs',
    find: '        check_toward_target(before.buying, asset_value, vault_before, before.target_bps)?;\n',
    replace: '',
    fails: 'does not buy an asset that is at its target or over it',
  },
  {
    rule: 'direction: a purchase needs the asset under its target',
    file: 'src/checks.rs',
    find: 'weight < target',
    replace: 'true',
    fails: 'does not buy an asset that is at its target or over it',
  },
  {
    rule: 'direction: a sale needs the asset over its target',
    file: 'src/checks.rs',
    find: 'weight > target',
    replace: 'true',
    fails: 'does not sell an asset that is at its target or under it',
  },
  {
    rule: 'keeper_leg: the trade does not go past the band',
    file: 'src/instructions/keeper_leg.rs',
    find: / {8}check_inside_band\([^;]+;\n/,
    replace: '',
    fails: 'may end a purchase anywhere inside the band above the target, and not past it',
  },
  {
    rule: 'band: a purchase ends at most a band over the target',
    file: 'src/checks.rs',
    find: 'weight <= limit',
    replace: 'true',
    fails: 'may end a purchase anywhere inside the band above the target, and not past it',
  },
  {
    rule: 'band: a sale ends at most a band under the target',
    file: 'src/checks.rs',
    find: 'weight >= limit',
    replace: 'true',
    fails: 'may end a sale anywhere inside the band under the target, and not past it',
  },
  {
    rule: 'band: a purchase may end over the target, inside the band',
    file: 'src/checks.rs',
    find: 'target_bps as u32 + band_bps as u32',
    replace: 'target_bps as u32',
    fails: 'may end a purchase anywhere inside the band above the target, and not past it',
  },
  {
    rule: 'band: a sale may end under the target, inside the band',
    file: 'src/checks.rs',
    find: '(target_bps as u32).saturating_sub(band_bps as u32)',
    replace: 'target_bps as u32',
    fails: 'may end a sale anywhere inside the band under the target, and not past it',
  },
  {
    rule: 'keeper_leg: a leg ends closer to its target than it began',
    file: 'src/instructions/keeper_leg.rs',
    find: / {8}check_no_further\([^;]+;\n/,
    replace: '',
    fails: 'lets a sale that crosses the target end at most half as far under it',
  },
  {
    rule: 'distance: a leg that crosses its target ends at most half as far on the other side',
    file: 'src/checks.rs',
    find: 'let factor = if crossed { 2 } else { 1 };',
    replace: 'let factor = 1;',
    fails: 'lets a sale that crosses the target end at most half as far under it',
  },
  {
    rule: 'distance: a leg that stays on its side of the target is not held to the half',
    file: 'src/checks.rs',
    find: 'let factor = if crossed { 2 } else { 1 };',
    replace: 'let factor = 2;',
    fails: 'does not hold a leg that stays on its side of the target to the half',
  },
  {
    rule: 'distance: exactly half as far on the other side is allowed',
    file: 'src/checks.rs',
    find: 'off_after * vault_before * factor <= off_before * vault_after',
    replace: 'off_after * vault_before * factor < off_before * vault_after',
    fails: 'lets a sale that crosses the target end at most half as far under it',
  },
  {
    rule: 'distance: a purchase that crosses is held to the half',
    file: 'src/checks.rs',
    find: '(weight_before < target_before && weight_after > target_after)',
    replace: 'false',
    fails: 'lets a purchase that crosses the target end at most half as far over it',
  },
  {
    rule: 'distance: a sale that crosses is held to the half',
    file: 'src/checks.rs',
    find: '(weight_before > target_before && weight_after < target_after)',
    replace: 'false',
    fails: 'lets a sale that crosses the target end at most half as far under it',
  },
  {
    rule: 'distance: where a leg began is measured under the target too',
    file: 'src/checks.rs',
    find: 'weight_before.abs_diff(target_before)',
    replace: 'weight_before.saturating_sub(target_before)',
    fails: 'takes an asset from outside the band to inside it, on either side',
  },
  {
    rule: 'distance: where a leg began is measured over the target too',
    file: 'src/checks.rs',
    find: 'weight_before.abs_diff(target_before)',
    replace: 'target_before.saturating_sub(weight_before)',
    fails: 'lets a sale that crosses the target end at most half as far under it',
  },
  {
    rule: 'distance: where a leg ends is measured under the target too',
    file: 'src/checks.rs',
    find: 'weight_after.abs_diff(target_after)',
    replace: 'weight_after.saturating_sub(target_after)',
    fails: 'lets a sale that crosses the target end at most half as far under it',
  },
  {
    rule: 'distance: where a leg ends is measured over the target too',
    file: 'src/checks.rs',
    find: 'weight_after.abs_diff(target_after)',
    replace: 'target_after.saturating_sub(weight_after)',
    fails: 'lets a purchase that crosses the target end at most half as far over it',
  },
  {
    rule: 'keeper_leg: a leg that spends nothing is refused',
    file: 'src/instructions/keeper_leg.rs',
    find: requireLine('        ', 'spent > 0'),
    replace: '',
    fails: 'is not used up by a leg of nothing: a zero amount is refused',
  },
  {
    rule: 'keeper_leg: the vault is held to the largest value before the trade',
    file: 'src/instructions/keeper_leg.rs',
    find: 'let vault_before = vault_value(before.others, asset_value, cash_held)?;',
    replace: 'let vault_before = before.others + asset_value + cash_held as u128;',
    fails: 'is refused before the trade, and one at exactly that value is traded',
  },
  {
    rule: 'keeper_leg: the vault is held to the largest value after the trade',
    file: 'src/instructions/keeper_leg.rs',
    find: 'let vault_after = vault_value(before.others, asset_value_after, cash_after)?;',
    replace: 'let vault_after = before.others + asset_value_after + cash_after as u128;',
    fails: 'is refused after the trade, when what came in takes it past',
  },
  {
    rule: "keeper_leg: what is left of the week's losses is added to the leg's",
    file: 'src/instructions/keeper_leg.rs',
    find: 'let loss_used = decayed_loss(vault.loss_accum, vault.loss_ts, now) as u128 + loss;',
    replace: 'let loss_used = loss;',
    fails: 'adds the losses of the week up, across assets',
  },
  {
    rule: 'loss cap: a counter older than seven days reads nothing',
    file: 'src/checks.rs',
    find: '.clamp(0, LOSS_WINDOW_S)',
    replace: '.max(0)',
    fails: 'reads nothing of a counter last written a month ago',
  },
  {
    rule: 'loss cap: a counter stamped ahead of the clock reads no more than it holds',
    file: 'src/checks.rs',
    find: '.clamp(0, LOSS_WINDOW_S)',
    replace: '.min(LOSS_WINDOW_S)',
    fails: 'reads a counter stamped ahead of the clock in full, and no more',
  },
  {
    rule: 'keeper_leg: a leg that loses is held to the weekly cap',
    file: 'src/instructions/keeper_leg.rs',
    find: '            check_loss_cap(loss_used, vault_before, accounts.config.loss_cap_bps)?;\n',
    replace: '',
    fails: 'refuses a leg whose loss takes the week past the cap',
  },
  {
    rule: 'loss cap: the losses of the week stay within the cap',
    file: 'src/checks.rs',
    find: 'used <= cap',
    replace: 'true',
    fails: 'refuses a leg whose loss takes the week past the cap',
  },
  {
    rule: 'loss cap: a loss is forgotten over seven days',
    file: 'src/checks.rs',
    find: '((LOSS_WINDOW_S - elapsed) as u128)',
    replace: '(LOSS_WINDOW_S as u128)',
    fails: 'forgets a loss in a straight line over seven days',
  },
  {
    rule: 'keeper_leg: what a leg lost is written to the counter',
    file: 'src/instructions/keeper_leg.rs',
    find: / {12}vault\.loss_accum = [^;]+;\n/,
    replace: '',
    fails: 'adds the losses of the week up, across assets',
  },
  {
    rule: 'keeper_leg: the time of a loss is written with it',
    file: 'src/instructions/keeper_leg.rs',
    find: '            vault.loss_ts = now;\n',
    replace: '',
    fails: 'takes a purchase at exactly the tolerance, and counts what it lost',
  },
  {
    rule: 'keeper_leg: a leg that loses nothing is not held to the cap',
    file: 'src/instructions/keeper_leg.rs',
    find: '        if loss > 0 {\n            check_loss_cap',
    replace: '        if true {\n            check_loss_cap',
    fails: 'does not hold a leg that loses nothing to a cap that is used up',
  },
  {
    rule: 'keeper_leg: what the vault holds after the trade is recorded',
    file: 'src/instructions/keeper_leg.rs',
    find: '        vault.record_balance(&before.asset_mint, asset_after);\n',
    replace: '',
    fails: 'buys an asset that is under its target with cash, into the vault itself',
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
// All the rows that do not are listed at once.
const unsound = [];
for (const { rule, file, within, find, fails, cannotBite } of selected) {
  if (!cannotBite && !baseline.all.some((name) => name.includes(fails)))
    unsound.push(`${rule}: no test is named "${fails}"`);
  const source = readFileSync(join(PROGRAM, file), 'utf8');
  const [from, to] = scope(source, within);
  const matches = occurrences(source.slice(from, to), find);
  if (matches !== 1) unsound.push(`${rule}: the text to remove occurs ${matches} times in ${file}`);
}
if (unsound.length) throw new Error(`rows to repair:\n${unsound.join('\n')}`);

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
