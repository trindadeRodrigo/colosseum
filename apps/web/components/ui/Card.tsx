import type { ReactNode } from 'react';
import { cn } from './cn';
import { HatchBand, SampleNote } from './internal/mock-parts';
import { LatticeGlyph, LatticeStatus } from './Lattice';

// card.md. A card is a planed face: lighter than the ground, a hairline edge, no shadow, and at most
// one serif line. Depth comes from the three layers, never from a shadow. No photograph and no
// pattern goes inside one.

/** 24px of padding for consumer screens and docs; 16px for Monitor and Bearing. */
export type CardDensity = 'default' | 'dense';

const PAD: Record<CardDensity, string> = { default: 'p-6', dense: 'p-4' };

export type CardProps = {
  density?: CardDensity;
  /** A table panel: square corners, and the table inside owns its cells. */
  table?: boolean;
  /**
   * The card can be followed as a link: its edge deepens from hair to member on hover and it shows the
   * focus ring when the link inside has focus. Put the one link on the title (`CardHeader href`).
   */
  interactive?: boolean;
  /** A 2px edge in the brand wood on the left. Say it to assistive technology too, with `current`. */
  selected?: boolean;
  /** Sets `aria-current` on a selected card. */
  current?: 'page' | 'true';
  /**
   * The data inside is not live. The card draws both halves itself: a hatch band down its left edge
   * and one quiet line at its foot ("Sample figures"). Nothing else is needed (MOCK-QUIET).
   */
  mock?: boolean;
  /**
   * Words for that line, in the language of the view. `announce` is the line ("Sample figures");
   * `note` follows it after a dot: "test network", for a card whose figures come from one.
   */
  mockLabels?: { announce?: string; note?: string };
  as?: 'div' | 'section' | 'article' | 'li';
  'aria-labelledby'?: string;
  'aria-label'?: string;
  children: ReactNode;
  className?: string;
};

export function Card({
  density = 'default',
  table = false,
  interactive = false,
  selected = false,
  current,
  mock = false,
  mockLabels,
  as: Tag = 'div',
  children,
  className,
  ...aria
}: CardProps) {
  return (
    <Tag
      {...aria}
      data-ui="card"
      data-density={density}
      aria-current={selected ? (current ?? 'true') : undefined}
      className={cn(
        'group/card relative border border-border bg-card text-card-foreground',
        table ? 'rounded-none' : 'rounded-md',
        interactive &&
          'transition-colors hover:border-input focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring',
        selected && 'border-l-2 border-l-primary',
        mock && 'flex',
        className,
      )}
    >
      {mock ? (
        <>
          <HatchBand />
          <div className="min-w-0 flex-1">
            <div className="contents">{children}</div>
            {/* Said once, quietly, at the foot of the card (MOCK-QUIET). */}
            <SampleNote
              line={mockLabels?.announce}
              note={mockLabels?.note}
              className={density === 'dense' ? 'px-4 pb-3' : 'px-6 pb-5'}
            />
          </div>
        </>
      ) : (
        children
      )}
    </Tag>
  );
}

export type CardHeaderProps = {
  title: ReactNode;
  /** With an `href` the title is the card's one link, and the whole card can be clicked. */
  href?: string;
  /** At the right, in muted caption text. */
  meta?: ReactNode;
  density?: CardDensity;
  /** The heading level in the page outline. */
  level?: 2 | 3 | 4;
  id?: string;
  className?: string;
};

export function CardHeader({
  title,
  href,
  meta,
  density = 'default',
  level = 3,
  id,
  className,
}: CardHeaderProps) {
  const Heading = `h${level}` as 'h2' | 'h3' | 'h4';
  return (
    <div
      data-ui="card-header"
      className={cn('flex items-baseline justify-between gap-4', PAD[density], className)}
    >
      <Heading
        id={id}
        className={cn('min-w-0 font-semibold', density === 'dense' ? 'text-b-section' : 'text-h4')}
      >
        {href === undefined ? (
          title
        ) : (
          <a href={href} className="outline-none after:absolute after:inset-0">
            {title}
          </a>
        )}
      </Heading>
      {meta && <div className="shrink-0 text-caption text-muted-foreground">{meta}</div>}
    </div>
  );
}

type SectionProps = { density?: CardDensity; children: ReactNode; className?: string };

/** The body. After a header it starts with a full-width hairline. */
export function CardBody({ density = 'default', children, className }: SectionProps) {
  return (
    <div
      data-ui="card-body"
      className={cn(PAD[density], 'not-first:border-t not-first:border-border', className)}
    >
      {children}
    </div>
  );
}

/** The foot: source lines, explorer links, or the one link action. */
export function CardFooter({ density = 'default', children, className }: SectionProps) {
  return (
    <div
      data-ui="card-footer"
      className={cn(PAD[density], 'not-first:border-t not-first:border-border', className)}
    >
      {children}
    </div>
  );
}

export type StatProps = {
  label: string;
  /**
   * The value. A yield, a price or an FX figure goes in as a `ProvenancePin`, so it carries its source;
   * a count (plans, transactions) is plain text.
   */
  children: ReactNode;
  /** Bearing sets the value larger (`b-kpi`). */
  density?: CardDensity;
  className?: string;
};

/** One stat cell: a muted label above a mono value. */
export function Stat({ label, children, density = 'default', className }: StatProps) {
  return (
    <div
      data-ui="stat"
      className={cn('min-w-0', density === 'dense' ? 'p-4' : 'px-4 py-3', className)}
    >
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'font-mono font-medium tabular-nums',
          density === 'dense' ? 'text-b-kpi' : 'text-[1.125rem]/7',
        )}
      >
        {children}
      </dd>
    </div>
  );
}

/** Stat cells in a row, parted by hairlines and not by gaps. Two columns below 620px. */
export function StatRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl
      data-ui="stat-row"
      className={cn(
        'grid grid-cols-2 divide-x divide-border border border-border min-[620px]:grid-flow-col min-[620px]:auto-cols-fr min-[620px]:grid-cols-none',
        'max-[620px]:[&>*:nth-child(2n+1)]:border-l-0 max-[620px]:[&>*:nth-child(n+3)]:border-t max-[620px]:[&>*:nth-child(n+3)]:border-border',
        className,
      )}
    >
      {children}
    </dl>
  );
}

/** A card that is waiting: the still lattice and what it is waiting for. */
export function CardLoading({
  label,
  density = 'default',
}: {
  label: string;
  density?: CardDensity;
}) {
  return (
    <div data-ui="card-loading" className={PAD[density]}>
      <LatticeStatus label={label} />
    </div>
  );
}

export type CardEmptyProps = {
  /** One sentence. */
  sentence: string;
  /** One action: a `Button`. */
  action?: ReactNode;
  density?: CardDensity;
};

/** A card with nothing in it yet: a fragment of lattice, one sentence, one action. */
export function CardEmpty({ sentence, action, density = 'default' }: CardEmptyProps) {
  return (
    <div data-ui="card-empty" className={cn('flex items-center gap-4', PAD[density])}>
      <LatticeGlyph />
      <div className="flex flex-col items-start gap-2">
        <p className="text-body-sm text-foreground">{sentence}</p>
        {action}
      </div>
    </div>
  );
}
