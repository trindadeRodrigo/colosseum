import { HoneyFog } from '../../components/shell/HoneyFog';
import { buttonClass } from '../../components/ui/button-class';
import { Card } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';
import { ProvenancePin } from '../../components/ui/ProvenancePin';
import { dictionary, type Lang } from '../../i18n';
import { APP_HOME, LandingBar } from './LandingBar';
import { LandingSignIn } from './LandingSignIn';
import type { PlatformStats } from './stats';

// His landing page on the new identity (IDENTITY-2; the first demonstration of it, in
// identity-reassessment.html): the hero is the whole page. A static bar; the line "Tell it the goal.
// Get the portfolio cut for it." with "Start a plan" in front; the slow honey fog behind it; and the
// platform's numbers under it, each with its pin. Nothing more. Dark unless the visitor chose light
// (token-mapping.md: marketing is dark by default).

/** A plan to look at before starting one: the shared portfolios. */
export const SEE_A_PLAN = '/shelf';

export function Landing({
  lang,
  stats,
  signedIn = false,
}: {
  lang: Lang;
  stats: PlatformStats;
  /** Signed in on this browser: the bar leads back into the app, and nothing asks to sign in. */
  signedIn?: boolean;
}) {
  const { landing: t, shell } = dictionary(lang);
  const sandbox = stats.items.some((s) => s.obs.provenance === 'sandbox');
  const marked = !stats.live || sandbox;
  return (
    <div className="flex min-h-dvh flex-col">
      <LandingBar lang={lang} signedIn={signedIn} />
      {/* "Sign in" opens the sign-in dialog over the landing, loaded on the first press. */}
      <LandingSignIn />
      <main id="content" tabIndex={-1} className="flex flex-1 flex-col outline-none">
        <section
          data-ui="landing-hero"
          aria-labelledby="landing-title"
          className="relative isolate flex flex-1 items-center overflow-hidden"
        >
          <HoneyFog />
          <div className="relative mx-auto w-full max-w-page px-[clamp(16px,4vw,56px)] py-[clamp(56px,10vh,120px)]">
            <h1
              id="landing-title"
              className="max-w-[20ch] font-display text-[clamp(2.5rem,6.2vw,4.75rem)]/[round(1.04em,4px)] font-semibold tracking-[-0.035em]"
            >
              {t.hero.title}
            </h1>
            <p className="mt-6 max-w-[38rem] text-[clamp(1.0625rem,1.6vw,1.25rem)]/[round(1.5em,4px)] text-muted-foreground">
              {t.hero.lead}
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <a
                href={APP_HOME}
                className={cn(
                  buttonClass({ variant: 'primary' }),
                  'inline-flex h-12 items-center px-6 text-[1.0625rem]',
                )}
              >
                {t.hero.start}
              </a>
              <a
                href={SEE_A_PLAN}
                className={cn(
                  buttonClass({ variant: 'secondary' }),
                  'inline-flex h-12 items-center px-6 text-[1.0625rem]',
                )}
              >
                {t.hero.see}
              </a>
            </div>
          </div>
        </section>
        {/* A sample or test-network strip is a card marked as one (MOCK-QUIET): the hatch down its
            edge and one quiet line at its foot, drawn by the primitive. Edge to edge under the hero. */}
        <div data-ui="landing-stats" data-sample={marked ? '' : undefined}>
          <Card
            as="section"
            aria-label={t.stats.label}
            mock={marked}
            mockLabels={{ announce: stats.live ? shell.testNetworkLine : shell.mockAnnounce }}
            className="rounded-none! border-x-0 border-b-0 bg-background! text-foreground"
          >
            <dl className="mx-auto grid w-full max-w-page grid-cols-1 sm:grid-cols-3">
              {stats.items.map((s, i) => (
                <div
                  key={s.key}
                  className={cn(
                    'flex flex-col gap-2 px-[clamp(16px,4vw,56px)] py-6',
                    i > 0 && 'border-t border-border sm:border-t-0 sm:border-l',
                  )}
                >
                  <dt className="text-[12px]/4 font-medium tracking-[0.08em] text-muted-foreground uppercase">
                    {t.stats[s.key]}
                  </dt>
                  <dd className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <ProvenancePin
                      value={s.value}
                      obs={s.obs}
                      className="font-display text-[clamp(1.75rem,3vw,2.25rem)]/[round(1.1em,4px)] font-semibold tracking-[-0.02em]"
                    />
                    {s.change && (
                      <span
                        className={cn(
                          'text-[0.9375rem] font-medium',
                          s.change.up ? 'text-(--tf-status-on)' : 'text-(--tf-status-off)',
                        )}
                      >
                        <span className="sr-only">{s.change.up ? t.stats.up : t.stats.down} </span>
                        {s.change.text}
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      </main>
    </div>
  );
}
