'use client';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  mode: Mode;
  /** Ages are read against this; `stale` when the collectors' newest reading is old. */
  clock: Clock;
  /** The newest reading of the collectors, when the API gave one. */
  newest: string | null;
  base: () => Promise<Base>;
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
}: {
  children: ReactNode;
  /** A reader of a stub, in tests. */
  reader?: Reader;
  /** A fixed clock, in tests. */
  now?: number;
}) {
  const reader = useMemo(() => given ?? makeReader(), [given]);
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
    base?: Promise<Base>;
    lend?: Promise<LendRow[]>;
    dex: Map<string, Promise<DexAsset>>;
    generation?: number;
  }>({
    dex: new Map(),
  });

  const api = useMemo(() => {
    memo.current = { dex: new Map(), generation: gen };
    const base = () => {
      memo.current.base ??= Promise.all([
        reader.get<AssetsBody>(R.assets(TAU)),
        reader.get<PoolsBody>(R.pools()),
        reader.get<LendListBody>(R.lendList()),
        reader.get<RecordedBody>(R.recorded()),
      ]).then(([assets, pools, lendList, rec]) => ({
        assets,
        pools,
        lendList,
        recorded: new Set(rec.ok ? rec.body.pools.map((p) => p.address) : []),
      }));
      return memo.current.base;
    };
    const dexOne = (id: string) => {
      let p = memo.current.dex.get(id);
      if (!p) {
        // Per asset: the sheet at $100k (volume, LP share), 30 days of hourly capacity, its pools.
        // The unfiltered pool list stops at 500 rows, so pools are read per asset.
        p = Promise.all([
          reader.get<SheetBody>(R.sheet(id, 100_000)),
          reader.get<HistBody>(R.hist(id, TAU)),
          reader.get<PoolsBody>(R.poolsOf(id)),
        ]).then(([sheet, hist, pools]) => ({ sheet, hist, pools }));
        memo.current.dex.set(id, p);
      }
      return p;
    };
    const dex = async (ids: readonly string[]) => {
      const out: Record<string, DexAsset> = {};
      await inPool(ids, 6, async (id) => {
        out[id] = await dexOne(id);
      });
      return out;
    };
    const lending = () => {
      memo.current.lend ??= base().then(async (b) => {
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
  }, [reader, gen]);

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
      mode,
      clock: { now, stale: mode === 'stale' },
      newest,
      ...api,
      ui,
      setUi: (f) => setUiState(f),
      retry: () => setGen((g) => g + 1),
    }),
    [reader, mode, now, newest, api, ui],
  );
  return <BearingContext.Provider value={value}>{children}</BearingContext.Provider>;
}

/** A promise's answer as state: null until it settles, again null when its inputs change. */
export function useAnswer<T>(make: () => Promise<T> | null, deps: readonly unknown[]): T | null {
  const [state, setState] = useState<{ deps: readonly unknown[]; value: T } | null>(null);
  useEffect(() => {
    let live = true;
    const p = make();
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
