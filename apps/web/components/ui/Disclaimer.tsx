import { DISCLAIMER } from '@colosseum/schemas';
import { cn } from './cn';

// disclaimer-block.md. The product is not licensed advice and says so in full, at body size, where
// the plan is. The words come from the one DISCLAIMER constant: there is no prop that takes other
// text. It is not collapsible, cannot be dismissed, and is never footer small print.

export type DisclaimerLanguage = keyof typeof DISCLAIMER;

export type DisclaimerProps = {
  /** The language of the view. A bilingual view passes both and gets one paragraph for each. */
  lang: DisclaimerLanguage | readonly DisclaimerLanguage[];
  /** A short heading above the text, from the copy dictionary: "Not advice". */
  heading?: string;
  /** The accessible name of the block. */
  label?: string;
  className?: string;
};

export function Disclaimer({ lang, heading, label = 'Disclaimer', className }: DisclaimerProps) {
  const langs = typeof lang === 'string' ? [lang] : lang;
  return (
    <aside
      data-ui="disclaimer"
      aria-label={label}
      className={cn(
        'max-w-(--tf-measure-body) rounded-md border border-border px-6 py-4 text-foreground',
        className,
      )}
    >
      {heading && <p className="mb-1 text-caption font-semibold">{heading}</p>}
      {langs.map((code) => (
        <p
          key={code}
          lang={code}
          className="text-[length:var(--tf-e-body,1rem)] leading-[var(--tf-e-leading,1.5rem)] not-first:mt-2"
        >
          {DISCLAIMER[code]}
        </p>
      ))}
    </aside>
  );
}
