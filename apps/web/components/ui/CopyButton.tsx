'use client';
import { useEffect, useRef, useState } from 'react';
import { buttonClass } from './button-class';
import { cn } from './cn';
import { Hint } from './Hint';
import { Icon } from './Icon';
import { COPY_BUTTON_LABELS, type CopyButtonLabels } from './labels';

// Copies a value: the copy icon turns into a check for 1.5 seconds and the result is announced
// (data-table.md, the execution list). The check is used for nothing else.

export type { CopyButtonLabels } from './labels';

export type CopyButtonProps = {
  /** The full value, not the shortened one on screen. */
  value: string;
  /** What is copied, for the accessible name: "signature". */
  what?: string;
  labels?: Partial<CopyButtonLabels>;
  /** What the tooltip says, where it says more than the name: the whole value beside a shortened one. */
  title?: string;
  className?: string;
};

export function CopyButton({ value, what, labels, title, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const text = { ...COPY_BUTTON_LABELS, ...labels };
  const name = what ? `${text.copy} ${what}` : text.copy;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return; // no clipboard here: say nothing rather than claim a copy
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <>
      <Hint tip={title ?? name}>
        <button
          type="button"
          data-ui="copy-button"
          aria-label={name}
          onClick={copy}
          className={cn(buttonClass({ variant: 'icon', size: 'dense' }), className)}
        >
          <Icon name={copied ? 'Check' : 'Copy'} size={16} />
        </button>
      </Hint>
      <span role="status" className="sr-only">
        {copied ? text.copied : ''}
      </span>
    </>
  );
}
