'use client';
import { useState } from 'react';
import type { Res } from './data';
import { mk } from './fact';
import {
  iso,
  num,
  pct,
  pct0,
  type Regime,
  RW,
  reasonW,
  regimeW,
  short,
  usd,
  usd1,
  venueW,
} from './format';
import { SrcLine } from './parts';
import type { SimPath } from './sim';
import type { SplitBody } from './types';

// The ways out of a position as a flow (analytics2.js, flowChart): position → path → the pools a
// routed sale is split across (from the hourly split snapshot nearest the sale) → the token each pool
// pays out → the dollars received. Paths are alternatives, not one flow: each has its colour, the
// best one is drawn strongest, and issuer redemption is dashed because it rests on the issuer's terms.

type Node = {
  id: string;
  col: number;
  label: string;
  sub: string;
  cls: string;
  title: string;
  x: number;
  y: number;
  w: number;
};
type Edge = {
  a: Node;
  b: Node;
  path: string;
  label: string;
  w: number;
  tip: string;
  n: number;
  y0: number;
  y1: number;
  lx: number;
  ly: number;
};

const FLOW = [
  'var(--tf-bearing-f1)',
  'var(--tf-bearing-f2)',
  'var(--tf-bearing-f3)',
  'var(--tf-bearing-f4)',
];

export function FlowChart(o: {
  id: string;
  n: number;
  r: Regime;
  paths: readonly SimPath[];
  best: SimPath | null;
  splitNow: Res<SplitBody>;
  splitChunk: Res<SplitBody> | null;
  chunks: number;
}) {
  const [focus, setFocus] = useState<number | null>(null);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const byId = new Map<string, Node>();
  let seq = 0;
  const node = (id: string, col: number, label: string, sub: string, cls = '', title = '') => {
    const hit = byId.get(id);
    if (hit) return hit;
    const nd: Node = { id, col, label, sub, cls, title, x: 0, y: 0, w: 0 };
    byId.set(id, nd);
    nodes.push(nd);
    return nd;
  };
  const edge = (a: Node, b: Node, path: string, label: string, w: number, tip?: string) => {
    edges.push({ a, b, path, label, w, tip: tip || label, n: ++seq, y0: 0, y1: 0, lx: 0, ly: 0 });
  };
  const start = node('start', 0, `${o.id} · ${usd(o.n)}`, `your position, ${RW[o.r]}`, 'pos');
  const recv = node('recv', 4, 'Dollars received', 'USDC or USD', 'recv');
  const notes: string[] = [];
  let rank = 1;
  for (const p of o.paths) {
    const f = p === o.best ? 1 : ++rank;
    const cls = `f${f}${p === o.best ? ' best' : ''}${p.assumption ? ' assume' : ''}`;
    const pn = node(`path:${p.key}`, 1, p.name, p.when, `path ${cls}`);
    edge(start, pn, cls, '', 2.5, `${usd(o.n)} of ${o.id} into: ${p.name}`);
    const sp = p.key === 'now' ? o.splitNow : p.key === 'split' ? o.splitChunk : null;
    const lossTxt =
      p.loss.value != null
        ? usd1(o.n - p.loss.value)
        : p.assumption
          ? 'assumption'
          : 'not measured';
    const lossTip =
      p.loss.value != null
        ? `${p.name}: you receive ${usd(o.n - p.loss.value)}, a loss of ${usd(p.loss.value)} (${pct(p.loss.value / o.n)})`
        : `${p.name}: ${lossTxt}`;
    if (sp?.ok && sp.body.legs.length) {
      const sb = sp.body;
      const per = p.key === 'split' ? o.n / o.chunks : o.n;
      const quotes: Record<string, number> = {};
      const when = `${iso(sb.fetchedAt).slice(0, 16).replace('T', ' ')} UTC, ${regimeW(sb.regime)}`;
      notes.push(
        `${p.name}: ${
          sb.notionalUsd !== Math.round(per)
            ? `shares from the ${usd(sb.notionalUsd)} simulation, the nearest simulated size, `
            : 'split simulated at this size, '
        }${when}.`,
      );
      for (const l of sb.legs) {
        const pool = node(
          `pool:${l.pool}`,
          2,
          `${venueW(l.venue)} · ${l.quote || 'quote not named'}`,
          `${short(l.pool)}${l.feeRate != null ? ` · fee ${pct(l.feeRate)}` : ''}`,
          'pool',
          l.pool,
        );
        const k = p.key === 'split' ? o.chunks : 1;
        const amt = l.share * per;
        const tok = sb.refMidUsd ? (amt * k) / sb.refMidUsd : null;
        edge(
          pn,
          pool,
          cls,
          `${pct0(l.share)} · ${usd1(amt)}${k > 1 ? ` ×${k}` : ''}`,
          1 + 5 * l.share,
          `${p.name}: ${pct(l.share)} of each sale, ${usd(amt)}${k > 1 ? ` in each of ${k} sales` : ''}${
            tok != null ? `, ${num(tok, tok < 10 ? 2 : 1)} ${o.id} in all` : ''
          }, into ${venueW(l.venue)} ${short(l.pool)}`,
        );
        const qk = l.exitPath === 'via_sol' || l.quote === 'SOL' ? 'sol' : 'usd';
        const qn =
          qk === 'sol'
            ? node('q:sol', 3, 'SOL, swapped to USDC', 'a second hop', 'quote')
            : node('q:usd', 3, 'USDC / USDT', 'paid out by the pool', 'quote');
        edge(
          pool,
          qn,
          cls,
          l.costPct != null ? `cost ${pct(l.costPct)}` : 'cost not given',
          1 + 5 * l.share,
          `${p.name}: this leg costs ${l.costPct != null ? pct(l.costPct) : 'an amount not given'} (pool fee ${
            l.feeRate != null ? pct(l.feeRate) : 'not given'
          }, the rest price impact and basis), paid out in ${l.quote || 'the quote token'}`,
        );
        quotes[qk] = (quotes[qk] || 0) + l.share;
      }
      for (const qk of Object.keys(quotes)) {
        const share = quotes[qk] as number;
        edge(
          byId.get(`q:${qk}`) as Node,
          recv,
          cls,
          qk === 'usd' ? lossTxt : `${pct0(share)} of it`,
          1 + 5 * share,
          qk === 'usd'
            ? lossTip
            : `${p.name}: ${pct(share)} of the sale is paid in SOL and swapped to USDC`,
        );
      }
    } else if (p.assumption) {
      const iss = node('issuer', 3, 'Issuer redemption', 'settles T+5, KYC', 'quote assume');
      edge(pn, iss, cls, usd1(o.n), 2, `redeem ${usd(o.n)} with the issuer`);
      edge(
        iss,
        recv,
        cls,
        'assumption',
        2,
        'what the issuer pays rests on its published terms, a scenario input',
      );
    } else {
      const why =
        sp?.ok && sp.body.reason
          ? reasonW(sp.body.reason)
          : p.key === 'open'
            ? 'no split simulated in market hours yet'
            : 'no split for this path';
      const same = node('samepools', 2, 'The same pools', why, 'pool muted');
      edge(pn, same, cls, 'routed', 2, `${p.name}: the same routed sale; ${why}`);
      edge(same, recv, cls, lossTxt, 2, lossTip);
    }
  }
  // layout: fixed columns with wide gaps; labels live in the gaps, pushed apart so none overlaps
  const NW = [140, 180, 200, 150, 130];
  const GAPW = [92, 168, 120, 112];
  const NH = 48;
  const GAP = 34;
  const PAD = 28;
  const X: number[] = [];
  let x = 0;
  NW.forEach((w, c) => {
    X.push(x);
    x += w + (GAPW[c] || 0);
  });
  const cols = [0, 1, 2, 3, 4].map((c) => nodes.filter((nd) => nd.col === c));
  const Hmax = Math.max(...cols.map((cl) => cl.length * (NH + GAP) - GAP));
  cols.forEach((cl, c) => {
    const top = PAD + 24 + (Hmax - (cl.length * (NH + GAP) - GAP)) / 2;
    cl.forEach((nd, i) => {
      nd.x = X[c] as number;
      nd.w = NW[c] as number;
      nd.y = top + i * (NH + GAP);
    });
  });
  for (const nd of nodes) {
    const outs = edges.filter((e) => e.a === nd).sort((p, q) => p.b.y - q.b.y);
    const ins = edges.filter((e) => e.b === nd).sort((p, q) => p.a.y - q.a.y);
    outs.forEach((e, i) => {
      e.y0 = nd.y + 6 + ((NH - 12) * (i + 0.5)) / outs.length;
    });
    ins.forEach((e, i) => {
      e.y1 = nd.y + 6 + ((NH - 12) * (i + 0.5)) / ins.length;
    });
  }
  const H = Hmax + 2 * PAD + 34;
  const byGap = new Map<number, Edge[]>();
  for (const e of edges) {
    const x0 = e.a.x + e.a.w;
    const x1 = e.b.x - 2;
    if (e.b.col - e.a.col === 1) {
      e.lx = (x0 + x1) / 2;
      e.ly = (e.y0 + e.y1) / 2;
      const list = byGap.get(e.a.col) ?? [];
      list.push(e);
      byGap.set(e.a.col, list);
    }
  }
  const labelled: Edge[] = [];
  for (const list of byGap.values()) {
    list.sort((p, q) => p.ly - q.ly);
    let last = Number.NEGATIVE_INFINITY;
    for (const e of list) {
      e.ly = Math.max(e.ly, last + 16);
      last = e.ly;
    }
    const over = last - (H - 8);
    if (over > 0) for (const e of list) e.ly -= over;
    labelled.push(...list);
  }
  const W = (X[4] as number) + (NW[4] as number) + 4;
  const fOf = (cls: string) => Number(/\bf(\d)\b/.exec(cls)?.[1] ?? 0);
  const dim = (cls: string) => focus != null && fOf(cls) !== focus;
  const color = (cls: string) => FLOW[fOf(cls) - 1] ?? FLOW[3];
  const sn = o.splitNow.ok && o.splitNow.body.fetchedAt ? o.splitNow.body : null;
  const srcF = sn
    ? mk(1, {
        source: sn.source,
        fetchedAt: sn.fetchedAt,
        method: sn.method,
        methodVersion: sn.methodVersion,
      })
    : null;
  const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  return (
    <>
      <section
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls sideways must be reachable by keyboard
        tabIndex={0}
        aria-label="The paths as a flow, scrolls sideways"
        data-ui="bearing-flow"
        className="overflow-x-auto border border-border bg-card py-2"
        onMouseLeave={() => setFocus(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={`Flow of a ${usd(o.n)} sale of ${o.id} through each path, its pools and payout token, to the dollars received`}
          className="mx-auto block h-auto min-w-[880px]"
          style={{ maxWidth: W }}
        >
          <defs>
            <marker
              id="bearing-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L8,4 L0,8 Z" fill="context-stroke" />
            </marker>
          </defs>
          {edges.map((e) => {
            const x0 = e.a.x + e.a.w;
            const x1 = e.b.x - 2;
            const mx = (x0 + x1) / 2;
            const best = e.path.includes('best');
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: hover only highlights; the same figures are in the titles, the legend and the table
              <path
                key={e.n}
                d={`M${x0},${e.y0.toFixed(1)} C${mx},${e.y0.toFixed(1)} ${mx},${e.y1.toFixed(1)} ${x1},${e.y1.toFixed(1)}`}
                fill="none"
                stroke={color(e.path)}
                strokeWidth={e.w.toFixed(1)}
                strokeLinecap="round"
                strokeDasharray={e.path.includes('assume') ? '6 4' : undefined}
                markerEnd="url(#bearing-arrow)"
                opacity={dim(e.path) ? 0.12 : focus != null || best ? 1 : 0.55}
                onMouseEnter={() => setFocus(fOf(e.path))}
              >
                <title>{`[${e.n}] ${e.tip}`}</title>
              </path>
            );
          })}
          {labelled.map((e) => {
            const txt = `[${e.n}]${e.label ? ` ${e.label}` : ''}`;
            const tw = txt.length * 6.1 + 8;
            const best = e.path.includes('best');
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: hover only highlights; the same figures are in the titles, the legend and the table
              <g
                key={`l${e.n}`}
                opacity={dim(e.path) ? 0.12 : 1}
                onMouseEnter={() => setFocus(fOf(e.path))}
              >
                <title>{`[${e.n}] ${e.tip}`}</title>
                <rect
                  x={e.lx - tw / 2}
                  y={e.ly - 8}
                  width={tw}
                  height={15}
                  fill="var(--card)"
                  stroke="var(--border)"
                  strokeWidth={0.5}
                />
                <text
                  x={e.lx}
                  y={e.ly + 3.5}
                  textAnchor="middle"
                  className={`font-mono text-[10.5px] ${best ? 'fill-foreground' : 'fill-muted-foreground'}`}
                >
                  {txt}
                </text>
              </g>
            );
          })}
          {nodes.map((nd) => {
            const isPath = nd.cls.includes('path');
            const stroke = nd.cls.includes('best')
              ? 'var(--tf-bearing-f1)'
              : nd.cls.includes('pos')
                ? 'var(--primary)'
                : nd.cls.includes('recv')
                  ? 'var(--tf-bearing-cv)'
                  : 'var(--border)';
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: hover only highlights; the same figures are in the titles, the legend and the table
              <g
                key={nd.id}
                opacity={isPath && dim(nd.cls) ? 0.45 : 1}
                onMouseEnter={isPath ? () => setFocus(fOf(nd.cls)) : undefined}
              >
                <rect
                  x={nd.x}
                  y={nd.y}
                  width={nd.w}
                  height={NH}
                  fill="var(--muted)"
                  stroke={stroke}
                  strokeWidth={nd.cls.includes('best') ? 2 : 1}
                  strokeDasharray={nd.cls.includes('assume') ? '4 3' : undefined}
                />
                <text
                  x={nd.x + 10}
                  y={nd.y + 19}
                  className={`text-[12px] font-medium ${nd.cls.includes('muted') ? 'fill-muted-foreground' : 'fill-foreground'}`}
                >
                  {trunc(nd.label, 32)}
                </text>
                <text
                  x={nd.x + 10}
                  y={nd.y + 35}
                  className="fill-muted-foreground font-mono text-[11px]"
                >
                  {trunc(nd.sub, 38)}
                </text>
                {nd.cls.includes('best') && (
                  <text
                    x={nd.x + nd.w - 8}
                    y={nd.y + 35}
                    textAnchor="end"
                    fill="var(--tf-bearing-cv)"
                    className="text-[11px] font-semibold"
                  >
                    best
                  </text>
                )}
                <title>{`${nd.label} · ${nd.sub}${nd.title ? ` · ${nd.title}` : ''}`}</title>
              </g>
            );
          })}
          {['Position', 'Path', 'Pools the sale is split across', 'Paid out in', 'You receive'].map(
            (t, c) => (
              <text
                key={t}
                x={X[c]}
                y={16}
                className="fill-muted-foreground font-condensed text-[11.5px] font-medium"
              >
                {t}
              </text>
            ),
          )}
        </svg>
      </section>
      <p className="mt-2 max-w-[88ch] text-muted-foreground">
        Each colour is one path; they are alternatives, not one sale. The best path is drawn
        strongest; issuer redemption is dashed because it rests on the issuer’s terms. Line width
        follows each pool’s share of the sale. {notes.join(' ')} Received amounts and losses are the
        table’s, the fitted cost at the exact size; the split shows where the sale goes.
      </p>
      <SrcLine f={srcF} what="the flow chart" />
    </>
  );
}
