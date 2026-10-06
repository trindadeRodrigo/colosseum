'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { buttonClass } from '../../components/ui/button-class';
import { Composer } from '../../components/ui/Composer';
import { LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { GOAL_HANDOFF } from '../goal/draft';
import { GOAL_TEXT } from '../goal/read-goal';

// "Tell us what your money needs to do." (hero-3d.html, `#simulate`): the goal composer of the app, as
// his simulator lays it out. The landing page reads nothing and simulates nothing: what is typed here
// is handed to the goal screen (`/goal`), which reads it into limits the person can check, before
// they sign in. So there is no made-up plan on this page, only the real reader one step on.

/** `signedIn`: a person signed in on this browser is not asked to sign in. */
export function Simulate({ signedIn = false }: { signedIn?: boolean }) {
  const d = useT();
  const t = d.landing.sim;
  const lang = useLang();
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const box = useRef<HTMLDivElement>(null);

  function send(typed: string) {
    setBusy(true);
    try {
      window.sessionStorage.setItem(GOAL_HANDOFF, typed);
    } catch {
      // No storage in this browser: the goal screen opens empty, and the text is still in this box.
    }
    router.push('/goal');
  }

  return (
    <section
      id="simulate"
      aria-label={t.label}
      className="relative z-[2] scroll-mt-22 bg-background pt-15 pb-[clamp(72px,10vw,120px)]"
    >
      <div className="mx-auto grid w-full max-w-page items-start gap-6 px-[clamp(16px,4vw,56px)] min-[980px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] min-[980px]:gap-12">
        <div className="min-[980px]:sticky min-[980px]:top-24">
          <p className="font-mono text-[12px] font-medium tracking-[0.06em] text-primary">
            {t.eyebrow}
          </p>
          <h2 className="mt-2.5 mb-3 font-display text-[clamp(1.8rem,1.3rem+1.6vw,2.6rem)]/[round(1.15em,4px)] font-normal">
            {t.title}
          </h2>
          <p className="text-muted-foreground">{t.lead}</p>
        </div>
        <div ref={box} className="flex min-w-0 flex-col gap-4">
          <Composer
            label={d.goal.composer.label}
            labelHidden
            value={text}
            onChange={setText}
            onSubmit={send}
            placeholder={d.goal.composer.placeholder}
            maxLength={GOAL_TEXT.max}
            describedBy={hintId}
            busy={busy}
            lang={LOCALE[lang]}
            labels={{ submit: d.goal.composer.submit, busy: t.opening }}
          />
          <ul aria-label={d.goal.examples.label} className="flex flex-wrap gap-2">
            {t.examples.map((example) => (
              <li key={example}>
                <Button
                  variant="chip"
                  className="h-auto! min-h-8 py-1"
                  disabled={busy}
                  onClick={() => {
                    setText(example);
                    box.current?.querySelector('textarea')?.focus();
                  }}
                >
                  {example}
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap justify-between gap-x-6 gap-y-2 text-[13px]/5 text-muted-foreground">
            <p id={hintId} className="pt-0.5 font-mono text-[12px]/5">
              {d.goal.composer.hint}
            </p>
            {!signedIn && (
              <p>
                {d.goal.visitor.before}{' '}
                <Link href="/sign-in?next=/goal" className={buttonClass({ variant: 'link' })}>
                  {d.goal.visitor.link}
                </Link>{' '}
                {d.goal.visitor.after}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
