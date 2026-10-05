import type { AssetId, ChainId } from '@colosseum/schemas';
import devnet from '../../../../deployments/solana-devnet.json';
import { networkFor } from './readiness';

// What a raw amount of each token means: its symbol and its decimals, from what this repository
// committed, never from what the API answers. A hostile API that said the cash token had 9 decimals
// would have a deposit of 40,000 dollars read as 40: the order screen shows and checks every amount
// with these. The test network's tokens are the ones its deploy recorded (deployments/
// solana-devnet.json); the mock's cash token is the mock's own dollar (6 decimals,
// tests/web-units.test.ts holds it to packages/chain-mock). Anything else has no units here, and
// nothing is signed for it.

export type TokenUnits = { symbol: string; decimals: number };
export type ChainUnits = { cash: AssetId; tokens: Partial<Record<AssetId, TokenUnits>> };

type RecordToken = { id: string; symbol: string; decimals: number };
const fromRecord = (record: {
  chain: string;
  cash: RecordToken;
  assets: RecordToken[];
  retired: RecordToken[];
}): ChainUnits => ({
  cash: record.cash.id,
  tokens: Object.fromEntries(
    [record.cash, ...record.assets, ...record.retired].map((t) => [
      t.id,
      { symbol: t.symbol, decimals: t.decimals },
    ]),
  ),
});

/** The mock's dollar, as packages/chain-mock lists it. */
export const MOCK_CASH: TokenUnits = { symbol: 'USDC', decimals: 6 };

/** The units of a chain's tokens on the network this app signs for, or null when none are committed. */
export function unitsFor(chain: ChainId, mock: boolean): ChainUnits | null {
  if (mock) {
    const cash = `${chain}:usdc`;
    return { cash, tokens: { [cash]: MOCK_CASH } };
  }
  if (chain === 'solana' && networkFor(chain, false) === 'testnet')
    return fromRecord(devnet as Parameters<typeof fromRecord>[0]);
  return null;
}
