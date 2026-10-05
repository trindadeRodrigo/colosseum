'use client';
import type { ReactNode } from 'react';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';

// One choice among a few, as a toggle chip (button.md, `chip`). The chip that is chosen says so three
// ways: `aria-pressed` to a screen reader, the brand wood on its edge and text, and a check mark, so
// that the choice is never told apart by a colour alone.

export type ChoiceChipProps = {
  chosen: boolean;
  onChoose: () => void;
  /** Muted and set aside, while something is being stored. */
  disabled?: boolean;
  /** The language of the label, when it is not the page's: "Português" on an English page. */
  lang?: string;
  children: ReactNode;
};

export function ChoiceChip({ chosen, onChoose, disabled, lang, children }: ChoiceChipProps) {
  return (
    <Button variant="chip" pressed={chosen} disabled={disabled} lang={lang} onClick={onChoose}>
      {chosen && <Icon name="Check" size={16} className="mr-1.5 shrink-0" />}
      {children}
    </Button>
  );
}
