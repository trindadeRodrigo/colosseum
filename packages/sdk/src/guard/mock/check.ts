import {
  base58Encode,
  base64Decode,
  hexDecode,
  hexEncode,
  utf8Decode,
  utf8Encode,
} from '../../bytes';
import { sha256 } from '../../hash';
import { type Context, familyOf, isUnlimited, reading, sameWeights, tradesOf } from '../context';
import { familyTextHash } from '../meta';
import { GuardRefusal } from '../refusal';
import type { ApprovedTrade, MockDeployment } from '../types';

// A transaction of packages/chain-mock against the step. The mock's bytes are not a transaction: they
// are the operation the mock chain will run, written as JSON, with the minimums beside it. This reads
// that operation and holds it to the step as the two real formats are held: the same owner, the same
// vault, the same amounts, minimums, targets and switches, and no field the step does not account for.
// Only a deployment that says the chain runs on the mock is ever checked this way.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Fields = { [key: string]: Json };

const isFields = (v: Json | undefined): v is Fields =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** An address the mock makes: a hash of what it names, in the chain's own form. */
export function mockAddress(chain: string, label: string): string {
  const hash = sha256(utf8Encode(`mock:${chain}:${label}`));
  return familyOf(chain as never) === 'solana'
    ? base58Encode(hash)
    : `0x${hexEncode(hash).slice(0, 40)}`;
}

/** The mock's vault of one owner for one plan. */
export const mockVaultAddress = (chain: string, owner: string, basketId: string) =>
  mockAddress(chain, `vault:${owner}:${basketId}`);

/** The chain id the mock builds for: no network at all. */
const MOCK_EVM_CHAIN_ID = 0;

/** The keys an operation of each kind may carry. One it does not list is a field the step cannot account for. */
const FIELDS: Record<string, readonly string[]> = {
  approve: ['owner', 'basketId', 'amountRaw', 'spender'],
  create_vault: [
    'owner',
    'basketId',
    'targets',
    'recipeOnchainId',
    'expectedVersion',
    'autoFollow',
    'depositRaw',
    'trades',
    'slippageBps',
  ],
  deposit: ['vault', 'amountRaw', 'trades', 'slippageBps'],
  swap: ['vault', 'trades', 'slippageBps'],
  set_targets: ['vault', 'targets'],
  accept_version: ['vault', 'recipeOnchainId', 'expectedVersion'],
  set_auto_follow: ['vault', 'on'],
  withdraw: ['vault', 'assets'],
  publish: ['creator', 'recipe'],
};

/** What the mock's publish carries of a recipe. The version and the time are the mock's to give. */
const RECIPE_FIELDS = [
  'schemaVersion',
  'familyId',
  'chain',
  'onchainId',
  'creator',
  'kind',
  'version',
  'effectiveAt',
  'components',
  'metaHash',
  'maxFeeBps',
  'flags',
];

export function checkMock(ctx: Context, deployment: MockDeployment): void {
  const { step, tx, need } = ctx;
  const { legId, owner } = step;
  const family = familyOf(deployment.chain);
  const malformed = (message: string) => new GuardRefusal('malformed', message, legId);
  // The mock has one operation for a first version and the next: it tells them apart itself. It has
  // none for taking a version back, which its control does for a test.
  if (step.kind === 'publish' && step.action === 'cancel')
    throw new GuardRefusal('unsupported', 'the mock takes back no version by a transaction', legId);

  const { message, hashed } = reading('the payload', legId, () => {
    if (family === 'solana') {
      // One empty signature slot, then the message.
      const bytes = base64Decode(tx.payload);
      if (bytes[0] !== 1 || bytes.length <= 65) throw new Error('not a mock transaction');
      const body = bytes.slice(65);
      return { message: JSON.parse(utf8Decode(body)) as Json, hashed: body };
    }
    const evm = tx.evm;
    if (!evm) throw new Error('an EVM transaction names its target');
    const data = hexDecode(tx.payload);
    // The rule of the shared types (`evmCallPreimage`), as the mock applies it.
    const preimage = `evm:${evm.chainId}:${tx.signer.toLowerCase()}:${evm.to.toLowerCase()}:${evm.value}:0x${hexEncode(data)}`;
    return { message: JSON.parse(utf8Decode(data)) as Json, hashed: utf8Encode(preimage) };
  });
  if (!isFields(message) || message.mock !== true || !isFields(message.op))
    throw malformed('the payload is not an operation of the mock chain');
  const { op } = message;
  const a = op.a;
  if (typeof op.kind !== 'string' || !isFields(a))
    throw malformed('the mock operation has no kind or no arguments');

  need(
    'hash',
    hexEncode(sha256(hashed)) === tx.messageHash,
    'the message hash stated is not the hash of the bytes',
  );
  need('chain', message.chain === step.chain, `the operation is for ${String(message.chain)}`);
  need('signer', message.signer === owner, `the operation is signed by ${String(message.signer)}`);
  need('step', op.kind === step.kind, `the operation is a ${op.kind}, and the step a ${step.kind}`);
  const vault = mockVaultAddress(deployment.chain, owner, step.basketId);
  if (family === 'evm') {
    // The mock's call is no transaction of any chain: it carries no value, names chain id 0, which is
    // no network, and goes where the mock sends that step. Held to all three, so that what passes as a
    // mock step could never be a transfer on a real chain.
    const evm = tx.evm;
    need('value', evm?.value === '0', `the call sends ${evm?.value} of the native token`);
    need(
      'network',
      evm?.chainId === MOCK_EVM_CHAIN_ID,
      `the call is for chain ${evm?.chainId}, and the mock's are for none`,
    );
    const target =
      step.kind === 'approve'
        ? mockAddress(deployment.chain, `asset:${deployment.cash.split(':')[1]}`)
        : vault;
    need(
      'target',
      evm?.to === target && message.to === target,
      `the call is to ${evm?.to}, and the mock sends this step to ${target}`,
    );
  }
  if (op.kind !== step.kind) return;

  const allowed = FIELDS[step.kind] ?? [];
  const extra = Object.keys(a).filter((key) => !allowed.includes(key));
  if (extra.length)
    throw malformed(
      `the operation carries ${extra.join(', ')}, which a ${step.kind} has no use for`,
    );

  const amountIs = (value: Json | undefined, want: string, what: string) =>
    need(
      'amount',
      (value ?? '0') === want,
      `the bytes ${what} ${String(value ?? '0')}, and the step ${want}`,
    );
  const targetsAre = (value: Json | undefined, want: { asset: string; weightBps: number }[]) => {
    const list = Array.isArray(value) ? value : [];
    need(
      'targets',
      sameWeights(
        want.map((t) => ({ key: t.asset, bps: t.weightBps })),
        list.map((t) => ({
          key: isFields(t) ? String(t.asset) : '',
          bps: isFields(t) && typeof t.weightBps === 'number' ? t.weightBps : -1,
        })),
      ),
      "the targets in the bytes are not the step's",
    );
  };
  const tradesAre = (value: Json | undefined, want: ApprovedTrade[]) => {
    const list = Array.isArray(value) ? value : [];
    const mins = Array.isArray(message.mins) ? message.mins : [];
    need(
      'calls',
      list.length === want.length && mins.length === want.length,
      `the bytes make ${list.length} trades, and the step ${want.length}`,
    );
    want.forEach((trade, i) => {
      const t = list[i];
      if (!isFields(t)) return;
      need(
        'asset',
        t.sell === trade.sell && t.buy === trade.buy,
        `a trade is ${String(t.sell)} for ${String(t.buy)}, and the step's is ${trade.sell} for ${trade.buy}`,
      );
      need(
        'amount',
        t.amountInRaw === trade.inRaw,
        `a trade sells ${String(t.amountInRaw)}, and the step ${trade.inRaw}`,
      );
      need(
        'minimum',
        mins[i] === trade.minOutRaw,
        `a trade accepts ${String(mins[i])} at the least, and the step ${trade.minOutRaw}`,
      );
    });
  };
  const vaultIs = () =>
    need(
      'vault',
      a.vault === vault,
      `the operation is on ${String(a.vault)}, and the plan's vault is ${vault}`,
    );
  const planIs = () => {
    need('owner', a.owner === owner, `the operation names ${String(a.owner)} as the owner`);
    need('vault', a.basketId === step.basketId, 'the operation is for another plan number');
  };

  switch (step.kind) {
    case 'approve':
      planIs();
      need(
        'spender',
        a.spender === vault,
        `the approval is for ${String(a.spender)}, and the plan's vault is ${vault}`,
      );
      amountIs(a.amountRaw, step.amountRaw, 'approve');
      need(
        'unlimited',
        typeof a.amountRaw === 'string' &&
          /^\d+$/.test(a.amountRaw) &&
          !isUnlimited(BigInt(a.amountRaw)) &&
          !isUnlimited(BigInt(step.amountRaw)),
        'an approval of everything is never signed',
      );
      break;
    case 'create_vault':
      planIs();
      targetsAre(a.targets, step.follow ? [] : step.targets);
      need(
        'version',
        (a.recipeOnchainId ?? null) === (step.follow?.recipeOnchainId ?? null) &&
          (a.expectedVersion ?? null) === (step.follow?.version ?? null),
        'the bytes follow another shared portfolio, or another version of it',
      );
      need(
        'auto_follow',
        a.autoFollow === step.autoFollow,
        'the bytes set auto-follow another way',
      );
      amountIs(a.depositRaw, step.depositRaw, 'deposit');
      tradesAre(a.trades, step.trades);
      break;
    case 'deposit':
      vaultIs();
      amountIs(a.amountRaw, step.amountRaw, 'deposit');
      tradesAre(a.trades, step.trades);
      break;
    case 'swap':
      vaultIs();
      tradesAre(a.trades, tradesOf(step));
      break;
    case 'set_targets':
      vaultIs();
      targetsAre(a.targets, step.targets);
      break;
    case 'accept_version':
      vaultIs();
      need(
        'version',
        a.recipeOnchainId === step.follow.recipeOnchainId &&
          a.expectedVersion === step.follow.version,
        'the bytes accept another shared portfolio, or another version of it',
      );
      break;
    case 'set_auto_follow':
      vaultIs();
      need('auto_follow', a.on === step.on, 'the bytes set auto-follow another way');
      break;
    case 'publish': {
      // The creator's own portfolio of this family, with the assets and weights and the hash of the
      // text the creator's form showed, worked out here; no fee and no flags.
      need('signer', a.creator === owner, `the operation publishes as ${String(a.creator)}`);
      const r = a.recipe;
      if (!isFields(r)) throw malformed('the publish carries no recipe');
      const more = Object.keys(r).filter((key) => !RECIPE_FIELDS.includes(key));
      if (more.length)
        throw malformed(`the recipe carries ${more.join(', ')}, which a publish has no use for`);
      const text = step.text;
      if (!text) throw malformed('a publish names the text it shows');
      need(
        'recipe',
        r.creator === owner &&
          r.chain === step.chain &&
          r.kind === 'community' &&
          r.familyId === step.familyId &&
          (r.onchainId === null ||
            r.onchainId === mockAddress(deployment.chain, `recipe:${owner}:${step.familyId}`)),
        "the bytes publish another creator's or another family's portfolio",
      );
      need(
        'recipe',
        r.metaHash === familyTextHash({ familyId: step.familyId, ...text }),
        'the bytes carry the hash of other words than the ones shown',
      );
      const lines = Array.isArray(r.components) ? r.components : [];
      need(
        'targets',
        lines.every((c) => isFields(c) && c.kind === 'asset') &&
          sameWeights(
            step.components.map((t) => ({ key: t.asset, bps: t.weightBps })),
            lines.map((c) => ({
              key: isFields(c) ? String(c.asset) : '',
              bps: isFields(c) && typeof c.weightBps === 'number' ? c.weightBps : -1,
            })),
          ),
        "the assets and weights in the bytes are not the step's",
      );
      need('limits', r.maxFeeBps === 0 && r.flags === 0, 'the bytes set a fee cap or flags');
      break;
    }
    case 'withdraw': {
      vaultIs();
      // The mock pays only the vault's owner, and takes whole balances.
      const assets = Array.isArray(a.assets) ? a.assets : [];
      const want = step.withdrawals === 'all' ? null : step.withdrawals.map((w) => w.asset);
      need(
        'asset',
        want === null || (assets.length === want.length && assets.every((id, i) => id === want[i])),
        'the bytes withdraw other tokens than the step names',
      );
      break;
    }
  }
}
