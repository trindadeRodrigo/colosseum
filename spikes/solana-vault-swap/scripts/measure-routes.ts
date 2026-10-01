// Read-only. Builds (never sends) the wrapped swap transaction for several Jupiter settings
// against mainnet lookup tables and prints size and account counts.
import { resolve } from 'node:path';
import { Connection } from '@solana/web3.js';
import {
  buildTx,
  buildVaultSwapIx,
  fetchRoute,
  loadAlts,
  loadKeypair,
  MAINNET_RPC,
  program,
  ROOT,
  type RouteOpts,
  txStats,
  vaultPda,
} from './common.ts';

const connection = new Connection(MAINNET_RPC, 'confirmed');
const payer = loadKeypair(resolve(ROOT, 'keys/local-owner.json')); // throwaway key, only shapes the message
const prog = program(connection, payer);
const vault = vaultPda(payer.publicKey, 1n);

const cases: [string, RouteOpts][] = [
  ['$10 default', { amount: 10_000_000n }],
  ['$10 maxAccounts=30', { amount: 10_000_000n, maxAccounts: 30 }],
  ['$10 direct only', { amount: 10_000_000n, onlyDirectRoutes: true }],
  ['$10 shared accounts', { amount: 10_000_000n, useSharedAccounts: true }],
  [
    '$10 Raydium CLMM direct',
    { amount: 10_000_000n, dexes: 'Raydium CLMM', onlyDirectRoutes: true },
  ],
  ['$1k default', { amount: 1_000_000_000n }],
  ['$1k maxAccounts=30', { amount: 1_000_000_000n, maxAccounts: 30 }],
  ['$50k default', { amount: 50_000_000_000n }],
  ['$50k maxAccounts=30', { amount: 50_000_000_000n, maxAccounts: 30 }],
];
for (const [name, opts] of cases) {
  try {
    const route = await fetchRoute(vault, opts);
    const ix = await buildVaultSwapIx(prog, payer.publicKey, vault, route);
    const alts = await loadAlts(connection, route.addressLookupTableAddresses);
    let stats: any;
    try {
      stats = txStats(
        await buildTx(connection, payer, [ix], alts, 400_000, 50_000),
        route.swapInstruction.accounts.length,
      );
    } catch (e: any) {
      stats = {
        buildError: String(e.message ?? e).slice(0, 120),
        jupiterIxAccounts: route.swapInstruction.accounts.length,
      };
    }
    const disc = Buffer.from(route.swapInstruction.data, 'base64').subarray(0, 8).toString('hex');
    console.log(
      JSON.stringify({
        case: name,
        dexes: route.quote.routePlan.map((r: any) => r.swapInfo.label).join(' > '),
        jupiterIx:
          { e517cb977ae3ad2a: 'route', c1209b3341d69c81: 'shared_accounts_route' }[disc] ?? disc,
        vaultNeedsExtraTokenAccounts: route.setupInstructions.length - 1,
        out: route.quote.outAmount,
        txBytes: stats.txBytes,
        accounts: stats.accountsTotal,
        jupAccounts: stats.jupiterIxAccounts,
        alts: stats.lookupTables,
        buildError: stats.buildError,
      }),
    );
  } catch (e: any) {
    console.log(JSON.stringify({ case: name, error: String(e.message ?? e).slice(0, 200) }));
  }
  await new Promise((r) => setTimeout(r, 7000));
}
