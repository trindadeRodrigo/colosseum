// Shared constants for the scripts: verified mints and Kamino addresses (docs/structurer/VERIFICATION.md).
export const MINTS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  USDY: 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6',
  syrupUSDC: 'AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj',
  SPYx: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
  QQQx: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ',
  BRS: 'BRSxQRUaGswjLs7ewcH7uXj3r7SgmfKSSLLXyCKHZtUo',
} as const;
export type MintSymbol = keyof typeof MINTS;

export const KAMINO_MAIN_MARKET = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF';
/** Main-market USDC reserve (the one with nine-figure deposits; two tiny USDC reserves also exist). */
export const KAMINO_USDC_RESERVE = 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59';
export const KAMINO_API = 'https://api.kamino.finance';
export const JUPITER_API_BASE = process.env.JUPITER_API_BASE ?? 'https://api.jup.ag/swap/v1';
export const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

export const nowIso = () => new Date().toISOString();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function jupHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (process.env.JUPITER_API_KEY) h['x-api-key'] = process.env.JUPITER_API_KEY;
  return h;
}

export async function jupQuote(
  inputMint: string,
  outputMint: string,
  amountBase: bigint,
  slippageBps = 50,
) {
  const url = `${JUPITER_API_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountBase}&slippageBps=${slippageBps}`;
  const res = await fetch(url, { headers: jupHeaders() });
  const body = (await res.json()) as Record<string, unknown>;
  return { url, status: res.status, body, rateRemaining: res.headers.get('x-ratelimit-remaining') };
}

export async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = (await res.json()) as { result?: T; error?: unknown };
  if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}

export type VerifyResult = {
  id: string;
  item: string;
  status: 'pass' | 'fail' | 'partial';
  how: string;
  value: unknown;
  fetchedAt: string;
  note?: string;
};
export function print(r: VerifyResult) {
  console.log(JSON.stringify(r));
}
