'use client';
import type { ChainId, Provenance } from '@colosseum/schemas';
import { useId } from 'react';
import { ChainLogo } from '../../components/ui/ChainLogo';
import { cn } from '../../components/ui/cn';
import { MockPlate } from '../../components/ui/MockPlate';
import { shortAddress } from '../shared/use-person';

// The chain of one thing, chosen where it starts (gate CHAIN-AT-THE-PLAN): a new plan on /goal, a buy of
// a shared portfolio that has a recipe on each chain. Two options side by side, a radio group: the
// chain's name, the person's wallet there cut to its ends, and the sample glyph with "test network"
// where the chain is not live (MOCK-QUIET). The chain's own mark comes before its name where there is a
// file for it (Thom, 2026-10-09). The chosen
// one is tinted, never outlined in honey (card.md), and its words stay in the foreground colour: muted
// text on the tint is under 4.5:1 on day.

export type ChainChoiceOption = {
  chain: ChainId;
  name: string;
  /** The person's wallet on the chain, whole. Null for someone signed out. */
  address: string | null;
  /** How the chain is run here: `port.network(chain).provenance`. */
  provenance: Provenance;
};

export type ChainChoiceLabels = {
  testNetwork: string;
  sampleFigure: string;
  /** The wallet's whole address, for a screen reader. */
  wallet: (address: string) => string;
  /** In place of the name of the chain being stored. */
  saving: string;
};

export function ChainChoice({
  legend,
  hint,
  options,
  value,
  onChange,
  busy = null,
  disabled = false,
  labels,
  className,
  'data-ui': dataUi = 'chain-choice',
}: {
  legend: string;
  /** One quiet line under the options. */
  hint?: string;
  options: readonly ChainChoiceOption[];
  value: ChainId;
  onChange: (chain: ChainId) => void;
  /** The chain a choice is being stored for: its name gives way to `labels.saving`. */
  busy?: ChainId | null;
  /** Nothing can be chosen now (a deposit is running, a reply is on its way): said in `hint`. */
  disabled?: boolean;
  labels: ChainChoiceLabels;
  className?: string;
  'data-ui'?: string;
}) {
  const name = useId();
  return (
    <fieldset
      data-ui={dataUi}
      aria-busy={busy !== null || undefined}
      className={cn('flex min-w-0 flex-col gap-2', className)}
    >
      <legend className="pb-2 text-body-sm font-medium">{legend}</legend>
      <div className="grid grid-cols-2 gap-2 [&>*]:min-w-0">
        {options.map((option) => (
          <label
            key={option.chain}
            data-chain={option.chain}
            className="flex cursor-pointer flex-col gap-1 rounded-md border border-input px-3 py-2 hover:bg-muted has-checked:border-transparent has-checked:bg-accent has-checked:hover:bg-accent has-disabled:cursor-not-allowed has-disabled:hover:bg-transparent has-disabled:has-checked:hover:bg-accent has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring"
          >
            <span className="flex items-center gap-2 text-body-sm font-medium">
              <input
                type="radio"
                name={name}
                value={option.chain}
                className="size-4 shrink-0 accent-primary"
                checked={option.chain === value}
                disabled={disabled}
                onChange={() => {
                  if (!disabled) onChange(option.chain);
                }}
              />
              <ChainLogo chain={option.chain} size={16} decorative />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {busy === option.chain ? labels.saving : option.name}
              </span>
            </span>
            {/* The wallet there, then how the chain is run: one quiet row under the name. */}
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
              {option.address && (
                <span className="font-mono text-source" title={option.address}>
                  <span aria-hidden="true">{shortAddress(option.address)}</span>
                  <span className="sr-only">{labels.wallet(option.address)}</span>
                </span>
              )}
              {option.provenance !== 'live' && (
                <>
                  <MockPlate labels={{ figure: labels.sampleFigure }} />
                  {option.provenance === 'sandbox' && <span>{labels.testNetwork}</span>}
                </>
              )}
            </span>
          </label>
        ))}
      </div>
      {hint && <p className="text-caption text-muted-foreground">{hint}</p>}
    </fieldset>
  );
}
