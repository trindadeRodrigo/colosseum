'use client';
import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from 'react';
import { type ButtonSize, type ButtonVariant, buttonClass } from './button-class';
import { cn } from './cn';

// button.md. One primary per view, and a button that signs is always primary and names the action and
// the amount ("Sign: swap 5 USDC → USDY"). A busy button changes its label; there is no spinner. A
// failed mainnet action is never tried again by the button: it returns to rest beside the error.

export type { ButtonSize, ButtonVariant } from './button-class';

type Shared = {
  size?: ButtonSize;
  /**
   * The label while the action runs, as a present participle: "Building your plan…". The button keeps
   * its width and its focus, and does not act again until `busy` is false.
   */
  busy?: boolean;
  busyLabel?: string;
  /** Muted, still focusable. Say why in words nearby and point `aria-describedby` at the sentence. */
  disabled?: boolean;
  /** Called when a disabled button is clicked: to move focus to the reason. */
  onDisabledClick?: () => void;
  /** A toggle: sets `aria-pressed`. For chips and icon buttons. */
  pressed?: boolean;
  /** With `href` the button is a link (`<a>`): for navigation. */
  href?: string;
  target?: string;
  rel?: string;
  children: ReactNode;
  className?: string;
};

type Native = Omit<
  ComponentPropsWithoutRef<'button'>,
  'children' | 'className' | 'disabled' | 'aria-label'
>;

export type ButtonProps = Native &
  Shared &
  (
    | { variant?: Exclude<ButtonVariant, 'icon'>; 'aria-label'?: string }
    /** An icon button has no visible text, so it must be named. The name is also its tooltip. */
    | { variant: 'icon'; 'aria-label': string }
  );

export function Button({
  variant = 'secondary',
  size = 'default',
  busy = false,
  busyLabel,
  disabled = false,
  onDisabledClick,
  pressed,
  href,
  target,
  rel,
  children,
  className,
  onClick,
  type = 'button',
  ...rest
}: ButtonProps) {
  const inert = busy || disabled;
  const classes = cn(buttonClass({ variant, size, busy, disabled }), className);
  // Both labels share one cell, so the width is that of the longer one in either state.
  const content =
    busyLabel === undefined ? (
      children
    ) : (
      <span className="grid">
        <span
          className={cn('col-start-1 row-start-1', busy && 'invisible')}
          aria-hidden={busy || undefined}
        >
          {children}
        </span>
        <span
          className={cn('col-start-1 row-start-1', !busy && 'invisible')}
          aria-hidden={!busy || undefined}
        >
          {busyLabel}
        </span>
      </span>
    );
  const state = {
    'data-ui': 'button',
    'data-variant': variant,
    'aria-busy': busy || undefined,
    'aria-disabled': inert || undefined,
    'aria-pressed': pressed,
    title: variant === 'icon' ? rest['aria-label'] : rest.title,
  } as const;

  if (href !== undefined) {
    const external = target === '_blank';
    return (
      <a
        aria-label={rest['aria-label']}
        aria-describedby={rest['aria-describedby']}
        id={rest.id}
        {...state}
        href={inert ? undefined : href}
        target={target}
        rel={rel ?? (external ? 'noopener' : undefined)}
        className={classes}
      >
        {content}
      </a>
    );
  }

  const click = (event: MouseEvent<HTMLButtonElement>) => {
    if (busy) return;
    if (disabled) {
      onDisabledClick?.();
      return;
    }
    onClick?.(event);
  };
  return (
    <button {...rest} {...state} type={type} onClick={click} className={classes}>
      {content}
    </button>
  );
}
