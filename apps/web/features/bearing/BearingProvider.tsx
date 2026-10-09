'use client';
import type { ChainId } from '@colosseum/schemas';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { recallChain, rememberChain } from '../account/chain-choice';
import { type BearingChain, FIRST, pickChain, withChain } from './chain';
import { inPool, makeReader, R, type Reader, type Res } from './data';
import type { DexAsset } from './dex';
import { type Clock, maxT, STALE_AFTER_MS } from './fact';
import { REGIMES } from './format';
import type { LendRow } from './lending';
import type {
  AssetsBody,
  HistBody,
  LendBody,
  LendHistBody,
  LendListBody,
  PoolsBody,
  RecordedBody,
  SheetBody,
} from './types';

// What the five Bearing pages share while a person moves between them: one reader of the risk API with
// its cache, the answers every page needs, whether the API is there and whether its figures are
// stale, and what the person chose on each page (filters, metric, range, tolerance, the sale they
// simulated). It lives in the section's layout, so it outlives a page.

export const TAU = 0.01;
/** How often an open page looks at its clock again. */
export const TICK_MS = 60_000;

export type Base = {
  assets: Res<AssetsBody>;
  pools: Res<PoolsBody>;
  lendList: Res<LendListBody>;
  recorded: Set<string>;
};

export type Selection = { assets: string[] | null; pools: string[] | null };
export type UiState = {
  sel: Record<string, Selection>;
  metric: Record<string, string>;
  range: number;
  tol: number;
  sim: { asset: string; size: number };
};

export type Mode = 'loading' | 'live' | 'stale' | 'none';

type Ctx = {
  reader: Reader;
  /** The chain the figures are read for (chain.ts). */
  chain: BearingChain;
  /** Reads another chain: named in the address and remembered as the bar remembers it. */
  setChain: (chain: BearingChain) => void;
  mode: Mode;
  /** Ages are read against this; `stale` when the collectors' newest reading is old. */
  clock: Clock;
  /** The newest reading of the collectors, when the API gave one. */
  newest: string | null;
  /** The chain's lists: its assets, pools, lending pools and recorded pools. */
  base: () => Promise<Base>;
  /** Per asset of the chain, by the symbol the page shows. */
  dex: (ids: readonly string[]) => Promise<Record<string, DexAsset>>;
  lending: () => Promise<LendRow[]>;
  ui: UiState;
  setUi: (f: (s: UiState) => UiState) => void;
  /** Reads everything again: a wait that gave up asks once more. */
  retry: () => void;
};

const BearingContext = createContext<Ctx | null>(null);

export function useBearing(): Ctx {
  const ctx = useContext(BearingContext);
  if (!ctx) throw new Error('useBearing: a Bearing page sits inside BearingProvider');
  return ctx;
}

/** A read that waits for the chain to be known: it settles once the provider asks again. */
const waitForChain = <T,>(): Promise<T> => new Promise<T>(() => {});

/** What a chain does not have: Robinhood Chain has no lending pools or recorded pools in Bearing. */
const notOnChain = <T,>(): Res<T> => ({ ok: false, status: 0, body: null, reason: 'not_on_chain' });

/** The collectors' newest reading: the latest end of any asset's capacity curve. */
export function newestReading(assets: Res<AssetsBody>): string | null {
  let last: string | null = null;
  if (assets.ok)
    for (const a of assets.body.assets)
      for (const r of REGIMES) {
        const c = a.capacityAtTau[r];
        if (c?.to) last = maxT(last, c.to);
      }
  return last;
}

/** Stale when the newest reading is older than the limit, or when there is none to go by. */
export function isStale(newest: string | null, now: number): boolean {
  return newest == null || now - Date.parse(newest) > STALE_AFTER_MS;
}

export function BearingProvider({
  children,
  reader: given,
  now: fixedNow,
  barChain,
  followsBar = false,
  moveBar,
}: {
  children: ReactNode;
  /** A reader of a stub, in tests. */
  reader?: Reader;
  /** A fixed clock, in tests. */
  now?: number;
  /**
   * The chain the app's bar is on: null when it says none, undefined while it is still finding out
   * (the account loading). Bearing follows it when it changes.
   */
  barChain?: ChainId | null;
  /** Mounted under the bar: the first pick waits for the bar to settle (BearingFromBar). */
  followsBar?: boolean;
  /**
   * Moves the bar's switcher to the chain chosen here, so the two agree. Given only for someone
   * signed out: a signed-in person's chain is where their plans are made, and the toggle here only
   * filters the page.
   */
  moveBar?: (chain: BearingChain) => void;
}) {
  const reader = useMemo(() => given ?? makeReader(), [given]);
  const router = useRouter();
  const pathname = usePathname();
  const [chain, setChainState] = useState<BearingChain>(FIRST);
  // Nothing is read before the chain is known: a page would otherwise read Solana's routes first.
  const [known, setKnown] = useState(false);
  const show = useCallback(
    (next: BearingChain) => {
      setChainState(next);
      rememberChain(next);
      router.replace(withChain(pathname, window.location.search, next));
    },
    [router, pathname],
  );
  // The bar has said what it says: at once outside the app, when the account has loaded inside it.
  const settled = !followsBar || barChain !== undefined;
  // The bar's chain at the first pick: a later change from it is a move of the bar's switcher.
  const lastBar = useRef<ChainId | null | undefined>(undefined);
  // The toggle here: the page reads the chain, and the bar of someone signed out goes with it. The
  // bar's answer is then not a move of its own to follow.
  const setChain = useCallback(
    (next: BearingChain) => {
      show(next);
      if (!moveBar) return;
      lastBar.current = next;
      moveBar(next);
    },
    [show, moveBar],
  );
  // On arrival, once the bar has settled: the address's chain, else the bar's, else this browser's,
  // else Solana, then named in the address so the page can be shared as it is. The account settling
  // is not a move of the bar: a link that names a chain keeps it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the bar has settled
  useEffect(() => {
    if (!settled || known) return;
    lastBar.current = barChain ?? null;
    const picked = pickChain(window.location.search, barChain, recallChain());
    setChainState(picked);
    setKnown(true);
    if (new URLSearchParams(window.location.search).get('chain') !== picked)
      router.replace(withChain(window.location.pathname, window.location.search, picked));
  }, [settled]);
  // The bar's switcher moved after the first pick: Bearing follows it.
  useEffect(() => {
    if (!known || barChain === undefined || barChain === lastBar.current) return;
    lastBar.current = barChain;
    if (barChain === 'solana' || barChain === 'robinhood') show(barChain);
  }, [barChain, known, show]);
  const [mode, setMode] = useState<Mode>('loading');
  const [newest, setNewest] = useState<string | null>(null);
  const [now, setNow] = useState(() => fixedNow ?? 0);
  const [ui, setUiState] = useState<UiState>({
    sel: {},
    metric: {},
    range: 2,
    tol: TAU,
    sim: { asset: 'TSLAx', size: 100_000 },
  });
  // A new generation drops every read kept so far: the API came back after it did not answer.
  const [gen, setGen] = useState(0);
  const modeRef = useRef<Mode>('loading');
  const newestRef = useRef<string | null>(null);
  const memo = useRef<{
    base: Map<BearingChain, Promise<Base>>;
    lend?: Promise<LendRow[]>;
    dex: Map<string, Promise<DexAsset>>;
    generation?: number;
  }>({
    base: new Map(),
    dex: new Map(),
  });

  const api = useMemo(() => {
    if (memo.current.generation !== gen)
      memo.current = { base: new Map(), dex: new Map(), generation: gen };
    const baseOf = (c: BearingChain) => {
      let p = memo.current.base.get(c);
      if (!p) {
        // Solana's addresses are read as they always were; Robinhood Chain's name it. Lending pools
        // and recorded pools are Solana's only.
        p = Promise.all([
          reader.get<AssetsBody>(R.assets(TAU, c)),
          reader.get<PoolsBody>(R.pools(c)),
          c === 'solana'
            ? reader.get<LendListBody>(R.lendList())
            : Promise.resolve(notOnChain<LendListBody>()),
          c === 'solana'
            ? reader.get<RecordedBody>(R.recorded())
            : Promise.resolve(notOnChain<RecordedBody>()),
        ]).then(([assets, pools, lendList, rec]) => ({
          assets,
          pools,
          lendList,
          recorded: new Set(rec.ok ? rec.body.pools.map((p) => p.address) : []),
        }));
        memo.current.base.set(c, p);
      }
      return p;
    };
    const base = () => (known ? baseOf(chain) : waitForChain<Base>());
    // An asset of Robinhood Chain is read by its address (the symbol is its name on the page).
    const keyOf = async (id: string) => {
      if (chain === 'solana') return id;
      const b = await baseOf(chain);
      return (b.assets.ok && b.assets.body.assets.find((a) => a.symbol === id)?.assetMint) || id;
    };
    const dexOne = (id: string) => {
      const k = `${chain}:${id}`;
      let p = memo.current.dex.get(k);
      if (!p) {
        // Per asset: the sheet at $100k (volume, LP share), 30 days of hourly capacity, its pools.
        // The unfiltered pool list stops at 500 rows, so pools are read per asset.
        p = keyOf(id).then((key) =>
          Promise.all([
            reader.get<SheetBody>(R.sheet(key, 100_000)),
            reader.get<HistBody>(R.hist(key, TAU)),
            reader.get<PoolsBody>(R.poolsOf(key, chain)),
          ]).then(([sheet, hist, pools]) => ({ sheet, hist, pools })),
        );
        memo.current.dex.set(k, p);
      }
      return p;
    };
    const dex = async (ids: readonly string[]) => {
      if (!known) return waitForChain<Record<string, DexAsset>>();
      const out: Record<string, DexAsset> = {};
      await inPool(ids, 6, async (id) => {
        out[id] = await dexOne(id);
      });
      return out;
    };
    const lending = () => {
      if (!known) return waitForChain<LendRow[]>();
      memo.current.lend ??= baseOf('solana').then(async (b) => {
        const list = b.lendList.ok ? b.lendList.body.pools : [];
        const rows = await inPool(list, 4, async (meta) => {
          const [sheet, h7, h30] = await Promise.all([
            reader.get<LendBody>(R.lend(meta.account)),
            reader.get<LendHistBody>(R.lendH(meta.account, 7)),
            reader.get<LendHistBody>(R.lendH(meta.account, 30)),
          ]);
          return { meta, sheet, h7, h30 };
        });
        const order = list.map((p) => p.account);
        return rows.sort((a, b2) => order.indexOf(a.meta.account) - order.indexOf(b2.meta.account));
      });
      return memo.current.lend;
    };
    return { base, dex, lending };
  }, [reader, gen, chain, known]);

  useEffect(() => {
    let live = true;
    const say = (m: Mode) => {
      modeRef.current = m;
      setMode(m);
    };
    reader.probe().then(async (up) => {
      if (!live) return;
      if (!up) {
        say('none');
        return;
      }
      const b = await api.base();
      if (!live) return;
      const at = fixedNow ?? Date.now();
      const last = newestReading(b.assets);
      newestRef.current = last;
      setNow(at);
      setNewest(last);
      say(isStale(last, at) ? 'stale' : 'live');
    });
    // Every minute: an open page turns stale when its readings age past the limit, and a page whose
    // API did not answer asks again, and reads everything afresh when it does.
    const tick =
      fixedNow == null
        ? setInterval(() => {
            if (modeRef.current === 'none') {
              reader.probe().then((up) => {
                if (live && up) setGen((g) => g + 1);
              });
              return;
            }
            if (modeRef.current === 'loading') return;
            const at = Date.now();
            setNow(at);
            say(isStale(newestRef.current, at) ? 'stale' : 'live');
          }, TICK_MS)
        : undefined;
    return () => {
      live = false;
      if (tick) clearInterval(tick);
    };
  }, [reader, api, fixedNow]);

  const value = useMemo<Ctx>(
    () => ({
      reader,
      chain,
      setChain,
      mode,
      clock: { now, stale: mode === 'stale' },
      newest,
      ...api,
      ui,
      setUi: (f) => setUiState(f),
      retry: () => setGen((g) => g + 1),
    }),
    [reader, chain, setChain, mode, now, newest, api, ui],
  );
  return <BearingContext.Provider value={value}>{children}</BearingContext.Provider>;
}

/**
 * A promise's answer as state: null until it settles, again null when its inputs change. The maker is
 * handed `left`, which says whether its answer was left: its inputs changed, or the page that asked
 * went away. Work still going on for an answer nobody waits for can stop there.
 */
export function useAnswer<T>(
  make: (left: () => boolean) => Promise<T> | null,
  deps: readonly unknown[],
): T | null {
  const [state, setState] = useState<{ deps: readonly unknown[]; value: T } | null>(null);
  useEffect(() => {
    let live = true;
    const p = make(() => !live);
    if (!p) return;
    p.then((value) => {
      if (live) setState({ deps, value });
    });
    return () => {
      live = false;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: the caller names what the answer depends on
  }, deps);
  return state &&
    state.deps.length === deps.length &&
    state.deps.every((d, i) => Object.is(d, deps[i]))
    ? state.value
    : null;
}
