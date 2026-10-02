import 'dotenv/config';
import {
  asAddress,
  buildDelegatedSwapTx,
  buildPolicySetupTx,
  createRpc,
  explorerTxUrl,
  loadKeypair,
  sendAndConfirm,
  simulateBase64,
  tokenAccountState,
} from '@colosseum/chain-solana';
import { createDb, markConfirmed, markFailed, markSent, recordBuilt } from '@colosseum/db';
import { REGISTRY_BY_ID } from '@colosseum/engine';

// D2-PM spike, mechanism A. Steps:
//   --step setup     user signs: approve 3 USDY to the agent + 0.02 SOL for agent fees
//   --step rebalance agent signs ALONE: 2 USDY (user) → syrupUSDC delivered to the user's ATA
//   --step balances  print user/agent balances
// Add --send to execute; otherwise build + simulate only.
const args = process.argv.slice(2);
const step = args[args.indexOf('--step') + 1] ?? 'balances';
const SEND = args.includes('--send');
const rpc = createRpc();
const owner = await loadKeypair();
const agent = await loadKeypair(process.env.AGENT_KEYPAIR_PATH ?? './secrets/agent.json');
const { db, client } = createDb();
const usdy = REGISTRY_BY_ID.get('usdy');
const syrup = REGISTRY_BY_ID.get('syrupusdc');
if (!usdy?.mint || !syrup?.mint) throw new Error('registry');
const USDY = asAddress(usdy.mint);
const SYRUP = asAddress(syrup.mint);

const bal = (ownerAddr: string, mint: typeof USDY) =>
  tokenAccountState(rpc, asAddress(ownerAddr), mint);
async function balances() {
  return {
    owner: {
      usdy: await bal(owner.address, USDY),
      syrupusdc: await bal(owner.address, SYRUP),
      sol: Number((await rpc.getBalance(owner.address).send()).value) / 1e9,
    },
    agent: {
      address: agent.address,
      usdy: await bal(agent.address, USDY),
      syrupusdc: await bal(agent.address, SYRUP),
      sol: Number((await rpc.getBalance(agent.address).send()).value) / 1e9,
    },
  };
}

async function run(
  kind: 'approve' | 'rebalance',
  build: () => Promise<{
    wire: Parameters<typeof sendAndConfirm>[1];
    signature: string;
    instructionCount: number;
  }>,
  extra: Record<string, unknown> = {},
) {
  const built = await build();
  const sim = await simulateBase64(rpc, built.wire);
  const line = {
    step,
    kind,
    instructions: built.instructionCount,
    simulation: sim.ok ? 'ok' : sim.err,
    unitsConsumed: sim.unitsConsumed,
    ...extra,
  };
  if (!sim.ok) return console.log(JSON.stringify({ ...line, logs: sim.logs.slice(-8) }));
  if (!SEND) return console.log(JSON.stringify({ ...line, sent: false, note: 'dry run' }));
  const wallet = kind === 'rebalance' ? agent.address : owner.address;
  const id = await recordBuilt(db, {
    wallet,
    chain: 'solana',
    kind,
    assetId: kind === 'rebalance' ? 'syrupusdc' : 'usdy',
    provenance: 'live',
  });
  await markSent(db, id, built.signature, explorerTxUrl(built.signature));
  const res = await sendAndConfirm(rpc, built.wire);
  if (res.err) {
    await markFailed(db, id, JSON.stringify(res.err));
    return console.log(
      JSON.stringify({
        ...line,
        signature: built.signature,
        explorer: explorerTxUrl(built.signature),
        status: 'failed',
        err: res.err,
      }),
    );
  }
  await markConfirmed(db, id);
  console.log(
    JSON.stringify({
      ...line,
      signature: built.signature,
      explorer: explorerTxUrl(built.signature),
      slot: res.slot,
      status: 'confirmed',
      signer: wallet,
    }),
  );
}

if (step === 'setup')
  await run(
    'approve',
    () => buildPolicySetupTx(rpc, owner, agent.address, USDY, 3_000_000n, 6, 20_000_000n),
    { approve: '3 USDY to agent', fund: '0.02 SOL to agent' },
  );
else if (step === 'rebalance')
  await run(
    'rebalance',
    () => buildDelegatedSwapTx(rpc, agent, owner.address, USDY, SYRUP, 2_000_000n, 6),
    { move: '2 USDY → syrupUSDC to owner ATA, agent-signed only' },
  );
console.log(JSON.stringify({ balances: await balances() }));
await client.end();
