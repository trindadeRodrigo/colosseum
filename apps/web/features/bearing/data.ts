import { API } from '../../lib/api';

// The risk API as the Bearing pages read it: the `/risk/*` routes apps/api serves (apps/risk-api serves
// the same routes alone). Every read resolves to an answer the page can show; none rejects. A failed
// read is a reason, never a made-up figure. Reads are cached for the life of the page, so moving
// between pages does not read the same route twice.

/** Where the risk routes are: their own API when set, else the app's API, which mounts them. */
export const RISK_API = (process.env.NEXT_PUBLIC_RISK_API_URL || API).replace(/\/$/, '');

export type Res<T = unknown> =
  | { ok: true; status: number; body: T; reason: null }
  | {
      ok: false;
      status: number;
      body: { error?: string; message?: string } | null;
      reason: string;
    };

/** A 404 for a route Fastify does not have says "Route GET:… not found": the API does not serve it. */
const notServed = (status: number, body: unknown) =>
  status === 404 && /^Route /.test(String((body as { message?: string } | null)?.message ?? ''));

export type Reader = {
  get: <T>(path: string) => Promise<Res<T>>;
  /** True when the API answered its methodology route: the one probe for "is it there". */
  probe: () => Promise<boolean>;
};

export function makeReader(base: string = RISK_API, fetcher: typeof fetch = fetch): Reader {
  const cache = new Map<string, Promise<Res>>();
  const get = <T>(path: string): Promise<Res<T>> => {
    let p = cache.get(path);
    if (!p) {
      p = fetcher(`${base}${path}`, { cache: 'no-store' })
        .then(async (r): Promise<Res> => {
          const body = await r.json().catch(() => null);
          return r.ok
            ? { ok: true, status: r.status, body, reason: null }
            : {
                ok: false,
                status: r.status,
                body,
                reason: notServed(r.status, body) ? 'not_served' : 'api_error',
              };
        })
        .catch((): Res => ({ ok: false, status: 0, body: null, reason: 'api_error' }));
      cache.set(path, p);
    }
    return p as Promise<Res<T>>;
  };
  const probe = () =>
    Promise.race([
      get(R.methodology()).then((r) => r.ok),
      new Promise<boolean>((done) => setTimeout(() => done(false), 3000)),
    ]);
  return { get, probe };
}

/** Run `fn` over `items`, `n` at a time. */
export async function inPool<I, O>(items: readonly I[], n: number, fn: (item: I) => Promise<O>) {
  const queue = items.slice();
  const out: O[] = [];
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift())
        out.push(await fn(item));
    }),
  );
  return out;
}

const enc = encodeURIComponent;
const size = (n: number) => Math.max(1, Math.round(n));

/** The routes the five pages read: the same paths Rodrigo's prototype reads. */
export const R = {
  methodology: () => '/risk/facts/methodology',
  assets: (tau: number) => `/risk/assets?tau=${tau}`,
  pools: () => '/risk/pools',
  poolsOf: (asset: string) => `/risk/pools?asset=${enc(asset)}`,
  sheet: (asset: string, n: number) => `/risk/facts/assets/${enc(asset)}?sizeUsd=${size(n)}`,
  hist: (asset: string, tau: number) => `/risk/assets/${enc(asset)}/history?days=30&tau=${tau}`,
  lendList: () => '/risk/facts/lending',
  lend: (account: string) => `/risk/facts/lending/${enc(account)}`,
  lendH: (account: string, days: number) =>
    `/risk/facts/lending/${enc(account)}/history?days=${days}`,
  liquidity: (pool: string) => `/risk/pools/${enc(pool)}/liquidity?bands=60&rangePct=0.3`,
  recorded: () => '/risk/pools/recorded',
  liqHist: (pool: string) => `/risk/pools/${enc(pool)}/liquidity/history?hours=720`,
  split: (asset: string, n: number) =>
    `/risk/assets/${enc(asset)}/split?side=sell&sizeUsd=${size(n)}`,
  recov: (asset: string, n: number) =>
    `/risk/recoverable?asset=${enc(asset)}&notional=${Math.round(n)}&hours=168&holderKyc=false`,
};
