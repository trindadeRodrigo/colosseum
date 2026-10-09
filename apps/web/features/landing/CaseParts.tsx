'use client';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { cn } from '../../components/ui/cn';
import type { SampleLeg } from './sample';

// The part of a sample case that is lit (goal-showcase-case.md, gate PLAN-JOINT): one for the whole
// card, so pointing at a layer of the plan's joint lights its row in the parts list and its series in
// the chart, and pointing at a row lights the layer. A part is named by its plan-leg colour, which is
// its place in the case's data, so the drawing, the list and the chart cannot name different parts.

type Lit = { lit: SampleLeg['chart'] | null; setLit: (chart: SampleLeg['chart'] | null) => void };

const LitContext = createContext<Lit>({ lit: null, setLit: () => {} });

/** The card's one lit part. */
export const useLitPart = () => useContext(LitContext);

export function CaseScope({ children }: { children: ReactNode }) {
  const [lit, setLit] = useState<SampleLeg['chart'] | null>(null);
  const value = useMemo(() => ({ lit, setLit }), [lit]);
  return <LitContext.Provider value={value}>{children}</LitContext.Provider>;
}

/** The swatch of a part: the plan-leg colour of its place (STYLE.md, plan leg). */
const SWATCH = { 1: 'bg-leg-1', 2: 'bg-leg-2', 3: 'bg-leg-3', 4: 'bg-leg-4' } as const;

/** The parts of the plan, by weight and reason; the one lit on the card is lit here too. */
export function Legs({
  legs,
  names,
  label,
}: {
  legs: readonly SampleLeg[];
  names: { name: string; why: string }[];
  label: string;
}) {
  const { lit, setLit } = useLitPart();
  return (
    <ul
      aria-label={label}
      className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-4 gap-y-1.5"
    >
      {legs.map((leg, i) => {
        const name = names[i];
        if (!name) return null;
        return (
          <li
            key={leg.chart}
            data-ui="case-leg"
            data-chart={leg.chart}
            data-lit={lit === leg.chart}
            onPointerEnter={(e) => e.pointerType === 'mouse' && setLit(leg.chart)}
            onPointerLeave={(e) => e.pointerType === 'mouse' && setLit(null)}
            className={cn(
              // content-start: a row-mate's two-line name makes the row taller, never this one's reason lower
              'grid grid-cols-[10px_1fr_auto] content-start items-baseline gap-x-2 text-[13px]/5 motion-safe:transition-opacity motion-safe:duration-150',
              lit !== null && lit !== leg.chart && 'opacity-45',
            )}
          >
            <span aria-hidden="true" className={`size-2.5 translate-y-px ${SWATCH[leg.chart]}`} />
            <span className={cn(lit === leg.chart && 'font-medium')}>{name.name}</span>
            <span className="font-mono text-[12px] font-medium tabular-nums">
              {leg.weightBps / 100}%
            </span>
            <span className="col-start-2 col-end-4 -mt-0.5 text-[12px]/4 text-muted-foreground">
              {name.why}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
