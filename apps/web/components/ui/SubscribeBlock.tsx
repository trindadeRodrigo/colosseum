'use client';
import { useEffect, useId, useState } from 'react';
import { Composer } from './Composer';
import { cn } from './cn';

// subscribe-block.md. The landing's closing section: a line above, the serif heading, a short lede, a
// framed photograph, and an email field in the shape of the composer. It is the one composition on
// marketing that may be centred. It makes no claim about performance and never asks for a wallet.
//
// What the visitor gets wrong, and what happened to the request, is the page's to work out: this block
// is told the status and says it.

export type SubscribeStatus =
  | 'rest'
  /** On submit: the address does not look complete. */
  | 'invalid-email'
  | 'no-option'
  | 'submitting'
  | 'success'
  | 'already'
  | 'error';

export type SubscribeLabels = {
  email: string;
  subscribe: string;
  subscribing: string;
  /** The name of the group of checkboxes. */
  group: string;
  status: Record<SubscribeStatus, string>;
};
export const SUBSCRIBE_LABELS: SubscribeLabels = {
  email: 'Email address',
  subscribe: 'Subscribe',
  subscribing: 'Subscribing…',
  group: 'What to receive',
  status: {
    rest: 'Unsubscribe any time.',
    'invalid-email': 'That email doesn’t look complete. Check for an @ and a domain.',
    'no-option': 'Pick at least one: product updates or the newsletter.',
    submitting: 'Subscribing…',
    success: 'Check your inbox to confirm.',
    already: 'You’re already on the list.',
    error: 'We couldn’t save that just now. Try again in a minute.',
  },
};

export type SubscribeOption = {
  id: string;
  label: string;
  /**
   * Whether it starts ticked. Whether the newsletter may start ticked is an open question in the specs
   * (consent): the page decides, and unticked is the safer choice.
   */
  defaultChecked?: boolean;
};

export type SubscribeBlockProps = {
  /** The short line above the heading, in sentence case: "Follow along". */
  eyebrow: string;
  /** The heading: this section's one serif line. */
  heading: string;
  /** Three lines at most. */
  lede: string;
  /** An unmodified photograph in a hairline frame, its caption below it and never on it. */
  photo?: { src: string; alt: string; caption: string };
  options: readonly SubscribeOption[];
  status?: SubscribeStatus;
  /** Called with what was typed and the ids of the ticked options. */
  onSubmit: (email: string, options: string[]) => void;
  placeholder?: string;
  labels?: Partial<Omit<SubscribeLabels, 'status'>> & {
    status?: Partial<SubscribeLabels['status']>;
  };
  className?: string;
};

const PROBLEMS: readonly SubscribeStatus[] = ['invalid-email', 'no-option', 'error'];

export function SubscribeBlock({
  eyebrow,
  heading,
  lede,
  photo,
  options,
  status = 'rest',
  onSubmit,
  placeholder,
  labels,
  className,
}: SubscribeBlockProps) {
  const text = {
    ...SUBSCRIBE_LABELS,
    ...labels,
    status: { ...SUBSCRIBE_LABELS.status, ...labels?.status },
  };
  const [email, setEmail] = useState('');
  const [ticked, setTicked] = useState(
    () => new Set(options.filter((o) => o.defaultChecked).map((o) => o.id)),
  );
  const headingId = useId();
  const group = useId();

  // Once the address is saved the field is cleared; after an error it is kept.
  useEffect(() => {
    if (status === 'success') setEmail('');
  }, [status]);

  const toggle = (id: string) =>
    setTicked((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const problem = PROBLEMS.includes(status);

  return (
    <section
      data-ui="subscribe-block"
      data-status={status}
      aria-labelledby={headingId}
      className={cn('flex flex-col items-center text-center', className)}
    >
      <p className="font-mono text-[0.75rem]/4 text-primary">{eyebrow}</p>
      <h2
        id={headingId}
        className="mt-3 max-w-[20ch] font-display text-h2 font-normal text-balance [font-variation-settings:'opsz'_36]"
      >
        {heading}
      </h2>
      <p className="mt-4 max-w-[52ch] text-body text-muted-foreground">{lede}</p>

      {photo && (
        <figure className="mt-10 w-[min(560px,100%)]">
          {/* biome-ignore lint/performance/noImgElement: a plain image, shown as it is: no filter, no overlay, and the caption below it */}
          <img
            src={photo.src}
            alt={photo.alt}
            className="block w-full rounded-md border border-border object-cover"
          />
          <figcaption className="mt-2 text-left font-mono text-[0.75rem]/4 text-muted-foreground">
            {photo.caption}
          </figcaption>
        </figure>
      )}

      <div className="mt-8 flex w-[min(520px,100%)] flex-col gap-3 text-left">
        <Composer
          variant="single"
          label={text.email}
          inputType="email"
          autoComplete="email"
          name="email"
          placeholder={placeholder}
          value={email}
          onChange={setEmail}
          onSubmit={(value) => onSubmit(value, [...ticked])}
          busy={status === 'submitting'}
          invalid={status === 'invalid-email'}
          sendText={text.subscribe}
          busySendText={text.subscribing}
          labels={{ send: text.subscribe, busy: '' }}
        />
        <fieldset aria-label={text.group} className="flex flex-wrap justify-center gap-x-5 gap-y-2">
          {options.map((option) => (
            <label
              key={option.id}
              htmlFor={`${group}-${option.id}`}
              className="inline-flex cursor-pointer items-center gap-1.5 text-[0.875rem]/5 text-muted-foreground"
            >
              <input
                id={`${group}-${option.id}`}
                type="checkbox"
                checked={ticked.has(option.id)}
                onChange={() => toggle(option.id)}
                className="size-4 rounded-none accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <p
          data-ui="subscribe-status"
          role={problem ? 'alert' : 'status'}
          className={cn(
            'text-center text-body-sm',
            problem ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {text.status[status]}
        </p>
      </div>
    </section>
  );
}
