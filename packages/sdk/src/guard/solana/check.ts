import { base64Decode, hexEncode } from '../../bytes';
import { sha256 } from '../../hash';
import { type Context, reading, sameWeights, tradesOf } from '../context';
import { familyTextHash } from '../meta';
import { type GuardCheck, GuardRefusal } from '../refusal';
import type { ApprovedStep, ApprovedTrade, SolanaDeployment, Withdrawal } from '../types';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  assetsAddress,
  COMPUTE_BUDGET_PROGRAM,
  configAddress,
  recipeAddress,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAMS,
  tokenAccountAddress,
  vaultAddress,
} from './addresses';
import { decodeArgs, type Value } from './borsh';
import type { IdlInstruction, ProgramTable } from './table';
import { parseSolanaTransaction, type WireInstruction } from './wire';

// A Solana transaction against the step. The bytes may hold three kinds of instruction and no other:
//   the vault program's, which must be exactly the step's (an owner's step, or a creator's registry
//     call on a shared portfolio of their own), with every account derived here from the person's
//     address and every argument equal to the step's;
//   "create this token account if it is missing", for the person's or their vault's account of a
//     token the step moves, paid by the person;
//   the compute unit limit and the compute unit price, once each, under the fee ceiling.
// System, token-program and router instructions are refused at the top level: a deposit moves tokens
// inside the vault program, and the router runs only inside the vault's swap.

/** The most a transaction may commit to fees where the deployment sets no ceiling: 0.005 SOL. */
export const DEFAULT_SOLANA_FEE_LAMPORTS = 5_000_000n;
const SIGNATURE_FEE_LAMPORTS = 5_000n;
/** What a transaction may use where it states no limit: the chain's own maximum. */
const MAX_COMPUTE_UNITS = 1_400_000n;
/** The instructions that pass accounts on: a swap's route, a withdrawal's transfer-hook accounts. */
const FORWARDS = new Set(['owner_swap', 'withdraw']);
/** The registry's instruction for each thing a creator does to a shared portfolio of their own. */
const REGISTRY = {
  publish: 'publish_recipe',
  update: 'update_recipe',
  cancel: 'cancel_pending',
} as const;
const REGISTRY_CALLS: ReadonlySet<string> = new Set(Object.values(REGISTRY));

type Rule = { address: string; check: GuardCheck };
type Token = { mint: string; program: string };
type Slot = { name: string; trade?: ApprovedTrade; withdrawal?: Withdrawal | null };
type Call = {
  name: string;
  spec: IdlInstruction;
  /** One address per account the instruction lists; null for one a lookup table loads. */
  accounts: (string | null)[];
  indexes: number[];
  args: { [name: string]: Value };
};

const littleEndian = (bytes: Uint8Array) =>
  [...bytes].reduceRight((n, b) => (n << 8n) | BigInt(b), 0n);

/** The vault program's instructions a step is made of, in order. Null: any number of withdrawals. */
function slotsOf(step: ApprovedStep): Slot[] | null {
  const swaps = (trades: ApprovedTrade[]) => trades.map((trade) => ({ name: 'owner_swap', trade }));
  switch (step.kind) {
    case 'create_vault':
      return [
        { name: 'create_vault' },
        ...(BigInt(step.depositRaw) > 0n ? [{ name: 'deposit' }] : []),
        ...swaps(step.trades),
      ];
    case 'deposit':
      return [{ name: 'deposit' }, ...swaps(step.trades)];
    case 'swap':
      return swaps(step.trades);
    case 'set_targets':
      return [{ name: 'set_targets' }];
    case 'accept_version':
      return [{ name: 'accept_version' }];
    case 'set_auto_follow':
      return [{ name: 'set_auto_follow' }];
    case 'withdraw':
      return step.withdrawals === 'all'
        ? null
        : step.withdrawals.map((withdrawal) => ({ name: 'withdraw', withdrawal }));
    case 'publish':
      return [{ name: REGISTRY[step.action] }];
    case 'approve':
      throw new GuardRefusal('unsupported', 'Solana needs no approval', step.legId);
  }
}

export function checkSolana(ctx: Context, deployment: SolanaDeployment, table: ProgramTable): void {
  const { step, tx, need } = ctx;
  const { legId, owner } = step;
  const unsupported = (message: string) => new GuardRefusal('unsupported', message, legId);

  const slots = slotsOf(step);
  for (const name of new Set((slots ?? [{ name: 'withdraw' }]).map((s) => s.name)))
    if (!table.instructions[name])
      throw unsupported(
        `the committed interface of the vault program has no ${name}: this step cannot be checked until the table is regenerated`,
      );

  const wire = reading('the payload', legId, () =>
    parseSolanaTransaction(base64Decode(tx.payload)),
  );
  need(
    'signer',
    wire.signers === 1 && wire.keys[0] === owner,
    'the person is not the one signer and fee payer of the bytes',
  );
  need(
    'hash',
    hexEncode(sha256(wire.message)) === tx.messageHash,
    'the message hash stated is not the hash of the bytes',
  );

  const program = table.address;
  const vault = reading('the owner', legId, () => vaultAddress(program, owner, step.basketId));
  const config = configAddress(program);
  const assets = assetsAddress(program);
  /** The creator's shared portfolio of the step's family, derived and never named. */
  const recipe =
    step.kind === 'publish'
      ? reading('the family', legId, () => recipeAddress(program, owner, step.familyId))
      : null;
  const token = (asset: string): Token => {
    const listed = deployment.assets[asset];
    if (!listed) throw unsupported(`the deployment lists no token for ${asset}`);
    return { mint: listed.mint, program: TOKEN_PROGRAMS[listed.tokenProgram] };
  };
  const account = (holder: string, t: Token) => tokenAccountAddress(holder, t.mint, t.program);
  const addressesOf = (ix: WireInstruction) => ix.accounts.map((i) => wire.keys[i] ?? null);

  // ---- every instruction is one of the three kinds
  const budget: WireInstruction[] = [];
  const helpers: WireInstruction[] = [];
  const calls: Call[] = [];
  for (const ix of wire.instructions) {
    const id = wire.keys[ix.program];
    if (id === COMPUTE_BUDGET_PROGRAM) budget.push(ix);
    else if (id === ASSOCIATED_TOKEN_PROGRAM) helpers.push(ix);
    else if (id === program) {
      const found = Object.entries(table.instructions).find(
        ([, spec]) =>
          ix.data.length >= spec.discriminator.length &&
          spec.discriminator.every((b, i) => ix.data[i] === b),
      );
      if (!found) {
        need('instruction', false, 'an instruction of the vault program that no interface names');
        continue;
      }
      const [name, spec] = found;
      calls.push({
        name,
        spec,
        accounts: addressesOf(ix),
        indexes: ix.accounts,
        args: reading(`the arguments of ${name}`, legId, () =>
          decodeArgs(spec.args, ix.data.slice(spec.discriminator.length), table.types),
        ),
      });
    } else need('program', false, `an instruction calls ${id}, which this step has no use for`);
  }

  // ---- the vault program's instructions are the step's, and nothing more
  const wanted: Slot[] =
    slots ??
    calls.filter((c) => c.name === 'withdraw').map(() => ({ name: 'withdraw', withdrawal: null }));
  const names = calls.map((c) => c.name);
  need(
    'instruction',
    names.length > 0 &&
      names.length === wanted.length &&
      names.every((n, i) => n === wanted[i]?.name),
    `the vault program is asked for [${names.join(', ')}], and this step is [${
      slots ? wanted.map((s) => s.name).join(', ') : 'withdraw, one or more'
    }]`,
  );

  // ---- each of them, account by account and argument by argument
  /**
   * The token accounts this transaction may open, and for whom. What comes into the vault may need the
   * vault's account for it: the cash of a deposit, either side of a trade. What leaves it may need the
   * person's. A withdrawal never opens an account of the vault.
   */
  const opens = new Map<string, { program: string; holder: string }>();
  const allow = (t: Token, holder: string) => opens.set(t.mint, { program: t.program, holder });
  if (step.kind === 'create_vault' || step.kind === 'deposit') allow(token(deployment.cash), vault);
  for (const trade of tradesOf(step)) {
    allow(token(trade.sell), vault);
    allow(token(trade.buy), vault);
  }
  /** What a withdrawal of everything may take: the deployment's tokens, and those the caller says the vault holds. */
  const takeable = new Map<string, Token>();
  if (step.kind === 'withdraw') {
    if (step.withdrawals === 'all') {
      for (const listed of Object.values(deployment.assets))
        takeable.set(listed.mint, {
          mint: listed.mint,
          program: TOKEN_PROGRAMS[listed.tokenProgram],
        });
      for (const held of step.held ?? []) {
        const program = held.tokenProgram && TOKEN_PROGRAMS[held.tokenProgram];
        if (!program) throw unsupported(`nothing says which token program owns ${held.address}`);
        if (!takeable.has(held.address))
          takeable.set(held.address, { mint: held.address, program });
      }
    } else for (const w of step.withdrawals) allow(token(w.asset), owner);
  }
  const taken = new Set<string>();

  const targetsIn = (value: Value | undefined) => {
    if (!Array.isArray(value)) throw unsupported('the interface writes targets another way');
    return value.map((t) => {
      const row = t as { [field: string]: Value };
      if (typeof row.mint !== 'string' || typeof row.target_bps !== 'number')
        throw unsupported('the interface writes a target another way');
      return { key: row.mint, bps: row.target_bps };
    });
  };
  const componentsIn = (value: Value | undefined) => {
    if (!Array.isArray(value)) throw unsupported('the interface writes components another way');
    return value.map((c) => {
      const row = c as { [field: string]: Value };
      if (typeof row.mint !== 'string' || typeof row.weight_bps !== 'number')
        throw unsupported('the interface writes a component another way');
      return { key: row.mint, bps: row.weight_bps };
    });
  };
  const targetsOf = (targets: { asset: string; weightBps: number }[]) =>
    targets.map((t) => ({ key: token(t.asset).mint, bps: t.weightBps }));

  let next = 0;
  for (const call of calls) {
    const slot = wanted[next];
    // An instruction out of place was refused above. With that check taken out it is passed over.
    if (!slot || slot.name !== call.name) continue;
    next += 1;

    const rules: Record<string, Rule> = {
      owner: { address: owner, check: 'owner' },
      vault: { address: vault, check: 'vault' },
      config: { address: config, check: 'accounts' },
      assets: { address: assets, check: 'accounts' },
      system_program: { address: SYSTEM_PROGRAM, check: 'accounts' },
    };
    const args: Record<string, (value: Value) => void> = {};
    /** The accounts this guard cannot do without. An interface that drops one is not one it knows. */
    const required = new Set(REGISTRY_CALLS.has(call.name) ? [] : ['owner', 'vault']);
    const rule = (name: string, address: string, check: GuardCheck) => {
      rules[name] = { address, check };
      required.add(name);
    };
    const tokenRules = (t: Token, names: { mint: string; program: string; held: string }) => {
      rule(names.mint, t.mint, 'asset');
      rule(names.program, t.program, 'accounts');
      rule(names.held, account(vault, t), 'accounts');
    };

    switch (call.name) {
      case 'create_vault': {
        if (step.kind !== 'create_vault') break;
        const follow = step.follow;
        // An optional account that is left out is passed as the program's own id. An interface with
        // no such account can open a vault with targets of its own and nothing else.
        if (follow) rule('recipe', follow.recipeOnchainId, 'version');
        else rules.recipe = { address: program, check: 'version' };
        args.basket_id = (v) =>
          need('vault', v === BigInt(step.basketId), 'the vault is opened for another plan number');
        args.targets = (v) =>
          need(
            'targets',
            sameWeights(follow ? [] : targetsOf(step.targets), targetsIn(v)),
            "the targets in the bytes are not the plan's",
          );
        args.auto_follow = (v) =>
          need('auto_follow', v === step.autoFollow, 'the bytes set auto-follow another way');
        args.expected_version = (v) =>
          need('version', v === (follow?.version ?? 0), 'the bytes name another version');
        break;
      }
      case 'deposit': {
        if (step.kind !== 'create_vault' && step.kind !== 'deposit') break;
        const cash = token(deployment.cash);
        const amount = step.kind === 'deposit' ? step.amountRaw : step.depositRaw;
        tokenRules(cash, { mint: 'mint', program: 'token_program', held: 'vault_token_account' });
        rule('source', account(owner, cash), 'recipient');
        args.amount = (v) =>
          need('amount', v === BigInt(amount), `the bytes deposit ${v}, and the step ${amount}`);
        break;
      }
      case 'owner_swap': {
        const trade = slot.trade;
        if (!trade) break;
        const [sell, buy] = [token(trade.sell), token(trade.buy)];
        tokenRules(sell, {
          mint: 'input_mint',
          program: 'input_token_program',
          held: 'vault_input',
        });
        tokenRules(buy, {
          mint: 'output_mint',
          program: 'output_token_program',
          held: 'vault_output',
        });
        rule('router_program', deployment.router, 'router');
        args.max_in = (v) =>
          need(
            'amount',
            v === BigInt(trade.inRaw),
            `the bytes sell ${v}, and the step ${trade.inRaw}`,
          );
        args.min_out = (v) =>
          need(
            'minimum',
            v === BigInt(trade.minOutRaw),
            `the bytes accept ${v} at the least, and the step ${trade.minOutRaw}`,
          );
        // The route: the router's own instruction, forwarded as it is. The vault holds the trade to
        // what it spends and receives, whatever the route says.
        args.data = () => {};
        break;
      }
      case 'withdraw': {
        const at = (name: string) =>
          call.accounts[call.spec.accounts.findIndex((a) => a.name === name)] ?? null;
        let t: Token;
        if (slot.withdrawal) t = token(slot.withdrawal.asset);
        else {
          // Everything the vault holds: the bytes choose which of the tokens it may take, and each
          // goes once. The token's program and every account are still worked out here.
          const mint = at('mint');
          const known = mint === null ? undefined : takeable.get(mint);
          need(
            'asset',
            known !== undefined && !taken.has(known.mint),
            `a withdrawal of ${mint ?? 'a token the message does not name'}, which the deployment does not list and the vault is not known to hold, or which is taken twice`,
          );
          if (!known) continue;
          taken.add(known.mint);
          t = known;
          allow(t, owner);
        }
        tokenRules(t, { mint: 'mint', program: 'token_program', held: 'vault_token_account' });
        rule('destination', account(owner, t), 'recipient');
        const amount = slot.withdrawal?.amountRaw ?? null;
        args.amount = (v) =>
          need(
            'amount',
            amount === null || v === BigInt(amount),
            `the bytes withdraw ${v}, and the step ${amount}`,
          );
        break;
      }
      case 'set_targets': {
        if (step.kind !== 'set_targets') break;
        args.targets = (v) =>
          need(
            'targets',
            sameWeights(targetsOf(step.targets), targetsIn(v)),
            "the targets in the bytes are not the step's",
          );
        break;
      }
      case 'accept_version': {
        if (step.kind !== 'accept_version') break;
        rule('recipe', step.follow.recipeOnchainId, 'version');
        args.expected_version = (v) =>
          need('version', v === step.follow.version, 'the bytes accept another version');
        break;
      }
      case 'set_auto_follow': {
        if (step.kind !== 'set_auto_follow') break;
        args.on = (v) =>
          need('auto_follow', v === step.on, 'the bytes set auto-follow another way');
        break;
      }
      case 'publish_recipe':
      case 'update_recipe':
      case 'cancel_pending': {
        if (step.kind !== 'publish' || !recipe) break;
        // The creator signs, and the shared portfolio is theirs for this family: never one named.
        rule(call.name === 'cancel_pending' ? 'signer' : 'creator', owner, 'owner');
        rule('recipe', recipe, 'recipe');
        if (call.name === 'cancel_pending') break;
        args.components = (v) =>
          need(
            'targets',
            sameWeights(targetsOf(step.components), componentsIn(v)),
            "the assets and weights in the bytes are not the version's",
          );
        // The hash of the text the creator saw, worked out here: never a hash handed over.
        const textHash = step.text ? familyTextHash({ familyId: step.familyId, ...step.text }) : '';
        args.meta_hash = (v) =>
          need(
            'recipe',
            v instanceof Uint8Array && hexEncode(v) === textHash,
            "the bytes publish another family's text",
          );
        if (call.name === 'update_recipe') break;
        args.family_id = (v) =>
          need(
            'recipe',
            v instanceof Uint8Array && hexEncode(v) === step.familyId,
            'the bytes publish another family',
          );
        args.max_fee_bps = (v) => need('limits', v === 0, `the bytes set a fee cap of ${v}`);
        args.flags = (v) => need('limits', v === 0, `the bytes set the flags ${v}`);
        break;
      }
    }

    for (const name of required)
      if (!call.spec.accounts.some((a) => a.name === name))
        throw unsupported(`the interface's ${call.name} has no account ${name}`);
    call.spec.accounts.forEach((spec, i) => {
      const expected = rules[spec.name];
      // An account the interface has and this guard has no rule for: the interface moved on.
      if (!expected)
        throw unsupported(`the guard has no rule for the account ${spec.name} of ${call.name}`);
      const actual = call.accounts[i];
      need(
        expected.check,
        actual === expected.address,
        `${call.name}: the account ${spec.name} is ${actual ?? 'not one the message names'}, and the step's is ${expected.address}`,
      );
    });
    const extra = call.indexes.slice(call.spec.accounts.length);
    need(
      'accounts',
      call.indexes.length >= call.spec.accounts.length &&
        (FORWARDS.has(call.name)
          ? // What is passed on to another program never includes a key that signed.
            extra.every((i) => i >= wire.signers)
          : extra.length === 0),
      `${call.name} carries accounts it has no use for`,
    );
    for (const spec of call.spec.args) {
      const holds = args[spec.name];
      if (!holds)
        throw unsupported(`the guard has no rule for the argument ${spec.name} of ${call.name}`);
      holds(call.args[spec.name] as Value);
    }
    for (const name of Object.keys(args))
      if (!call.spec.args.some((a) => a.name === name))
        throw unsupported(`the interface's ${call.name} has no argument ${name}`);
  }

  // ---- "create this token account if it is missing"
  const opened = new Set<string>();
  for (const ix of helpers) {
    const [payer, created, holder, mint, system, tokenProgram] = addressesOf(ix);
    const allowed = mint ? opens.get(mint) : undefined;
    const expected =
      holder && mint && tokenProgram && allowed?.program === tokenProgram
        ? tokenAccountAddress(holder, mint, tokenProgram)
        : null;
    need(
      'token_account',
      ix.data.length === 1 &&
        ix.data[0] === 1 &&
        ix.accounts.length === 6 &&
        payer === owner &&
        holder === allowed?.holder &&
        system === SYSTEM_PROGRAM &&
        expected !== null &&
        created === expected &&
        !opened.has(expected),
      "a token-account instruction that does not open the one account this step may need: the vault's for what comes in, the person's for what goes out",
    );
    if (expected) opened.add(expected);
  }

  // ---- the compute budget, and what it can cost
  let limit: bigint | null = null;
  let price: bigint | null = null;
  for (const ix of budget) {
    const [kind] = ix.data;
    if (kind === 2 && ix.data.length === 5 && ix.accounts.length === 0 && limit === null)
      limit = littleEndian(ix.data.slice(1));
    else if (kind === 3 && ix.data.length === 9 && ix.accounts.length === 0 && price === null)
      price = littleEndian(ix.data.slice(1));
    else
      need(
        'budget',
        false,
        'a compute-budget instruction other than one unit limit and one unit price',
      );
  }
  const max = BigInt(deployment.fee?.maxFeeNativeRaw ?? DEFAULT_SOLANA_FEE_LAMPORTS);
  // The price is in millionths of a lamport per unit; a part of a lamport is charged as a whole one.
  const priority = ((price ?? 0n) * (limit ?? MAX_COMPUTE_UNITS) + 999_999n) / 1_000_000n;
  const fee = SIGNATURE_FEE_LAMPORTS * BigInt(wire.signers) + priority;
  need('fee', fee <= max, `the bytes can cost ${fee} lamports in fees, above the ${max} allowed`);
}
