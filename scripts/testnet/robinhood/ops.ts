import { readFileSync } from 'node:fs';
import { callAs, loadEvmKey, type ScriptCall } from '@colosseum/chain-evm/server';
import { createEvmRpc, EvmDeploymentRecord, VAULT_FACTORY_ABI } from '@colosseum/chain-evm/vault';

// Robinhood Chain test network (46630) only. A dry run unless `--send`:
//
//   keeper <address> [--eth 0.002]   the factory names <address> its keeper (setKeeper, as the deployer),
//                                    and the price writer forwards it gas
//
// A test wallet is funded by fund-wallet.ts beside this.
//   ROBINHOOD_RPC_URL=<46630 node> ROBINHOOD_DEPLOYER_KEY=<path> ROBINHOOD_PRICE_WRITER_KEY=<path> \
//     pnpm exec tsx scripts/testnet/robinhood/ops.ts keeper 0x... [--send]
//
// The keys are read from the paths in the environment and never printed. Every call is simulated first;
// a refusal sends nothing. The node must answer the record's chain id, 46630.

const RECORD = EvmDeploymentRecord.parse(
  JSON.parse(
    readFileSync(new URL('../../../deployments/robinhood-testnet.json', import.meta.url), 'utf8'),
  ),
);
type Abi = ScriptCall['abi'];

const argv = process.argv.slice(2);
const [job, target] = argv;
const send = argv.includes('--send');
const flag = (name: string, fallback: string) => {
  const at = argv.indexOf(name);
  return at >= 0 ? (argv[at + 1] ?? fallback) : fallback;
};
const wei = (eth: string) => BigInt(Math.round(Number(eth) * 1e9)) * 10n ** 9n;
const env = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

async function main() {
  if (!target || !/^0x[0-9a-fA-F]{40}$/.test(target)) throw new Error('name the address');
  const to = target as `0x${string}`;
  const rpc = createEvmRpc(env('ROBINHOOD_RPC_URL'));
  const chainId = RECORD.evmChainId;
  const run = async (who: Parameters<typeof callAs>[0], call: Parameters<typeof callAs>[3]) => {
    const hash = await callAs(who, rpc, chainId, call, send);
    console.log(
      `${send ? 'sent' : 'would send'}\t${who.address}\t${call.what}${hash ? `\t${hash}` : ''}`,
    );
  };
  if (job === 'keeper') {
    const deployer = loadEvmKey(env('ROBINHOOD_DEPLOYER_KEY'));
    const writer = loadEvmKey(env('ROBINHOOD_PRICE_WRITER_KEY'));
    await run(deployer, {
      to: RECORD.contracts.factory as `0x${string}`,
      abi: VAULT_FACTORY_ABI as unknown as Abi,
      functionName: 'setKeeper',
      args: [to],
      what: `factory.setKeeper(${to})`,
    });
    const eth = flag('--eth', '0.002');
    await run(writer, {
      to,
      abi: [],
      functionName: '',
      value: wei(eth),
      what: `${eth} ETH to the keeper`,
    });
    return;
  }
  throw new Error('say keeper <address>; a wallet is funded by fund-wallet.ts');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
