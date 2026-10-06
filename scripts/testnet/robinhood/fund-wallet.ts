import { readFileSync } from 'node:fs';
import { callAs, loadEvmKey } from '@colosseum/chain-evm/server';
import { createEvmRpc, EvmDeploymentRecord } from '@colosseum/chain-evm/vault';

// Funds a fresh test wallet on Robinhood Chain's test network (46630) only, for a buy: the deployer
// mints <usd> tUSDG to <address> (granting itself the minter role on tUSDG first, as the token's admin,
// if it lacks it) and sends it <eth> of gas. A dry run unless `--send`:
//
//   wallet <address> [--usd 100] [--eth 0.0003]
//   ROBINHOOD_RPC_URL=<46630 node> ROBINHOOD_DEPLOYER_KEY=<path> \
//     pnpm exec tsx scripts/testnet/robinhood/fund-wallet.ts wallet 0x... [--send]
//
// The keys are read from the paths in the environment and never printed. Every call is simulated first;
// a refusal sends nothing. The node must answer the record's chain id, 46630.

const RECORD = EvmDeploymentRecord.parse(
  JSON.parse(
    readFileSync(new URL('../../../deployments/robinhood-testnet.json', import.meta.url), 'utf8'),
  ),
);
const TOKEN_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'grantRole',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'hasRole',
    stateMutability: 'view',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'MINTER_ROLE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
] as const;

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
  if (chainId !== 46_630) throw new Error('this script funds a wallet on 46630 only');
  const run = async (who: Parameters<typeof callAs>[0], call: Parameters<typeof callAs>[3]) => {
    const hash = await callAs(who, rpc, chainId, call, send);
    console.log(
      `${send ? 'sent' : 'would send'}\t${who.address}\t${call.what}${hash ? `\t${hash}` : ''}`,
    );
  };
  if (job === 'wallet') {
    const deployer = loadEvmKey(env('ROBINHOOD_DEPLOYER_KEY'));
    const cash = RECORD.cash.address as `0x${string}`;
    const role = (await rpc.readContract({
      address: cash,
      abi: TOKEN_ABI,
      functionName: 'MINTER_ROLE',
    })) as `0x${string}`;
    const minter = await rpc.readContract({
      address: cash,
      abi: TOKEN_ABI,
      functionName: 'hasRole',
      args: [role, deployer.address],
    });
    if (!minter)
      await run(deployer, {
        to: cash,
        abi: TOKEN_ABI,
        functionName: 'grantRole',
        args: [role, deployer.address],
        what: `tUSDG.grantRole(MINTER_ROLE, the deployer)`,
      });
    const usd = Number(flag('--usd', '100'));
    if (!minter && !send) {
      console.log(
        `would send\t${deployer.address}\ttUSDG.mint(${to}, ${usd} tUSDG), once the role is granted`,
      );
    } else
      await run(deployer, {
        to: cash,
        abi: TOKEN_ABI,
        functionName: 'mint',
        args: [to, BigInt(Math.round(usd * 1e6))],
        what: `tUSDG.mint(${to}, ${usd} tUSDG)`,
      });
    const eth = flag('--eth', '0.0003');
    await run(deployer, {
      to,
      abi: [],
      functionName: '',
      value: wei(eth),
      what: `${eth} ETH to the wallet`,
    });
    return;
  }
  throw new Error('say wallet <address>');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
