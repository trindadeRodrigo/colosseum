import { LanguageSwitch } from '../../components/shell/LanguageSwitch';
import { ThemeSwitch } from '../../components/shell/ThemeSwitch';
import { dictionary, type Lang, type ThemeChoice } from '../../i18n';
import { Closing } from './Closing';
import { JointStage } from './JointStage';
import { LandingNav } from './LandingNav';
import { Showcase } from './Showcase';
import { Simulate } from './Simulate';

// His landing page (hero-3d.html), section for section: the pinned joint and its three steps, the
// two sample people, the typing box, and the closing with the email field. Dark unless the visitor
// chose light (token-mapping.md: marketing is dark by default). Every figure on it is MOCK, and the
// foot says so in words too.

export function Landing({
  lang,
  theme,
  signedIn = false,
}: {
  lang: Lang;
  theme: ThemeChoice;
  /** Signed in on this browser: the bar leads back into the app, and nothing asks to sign in. */
  signedIn?: boolean;
}) {
  const t = dictionary(lang).landing;
  return (
    <>
      <LandingNav signedIn={signedIn} />
      <main id="content" tabIndex={-1} className="outline-none">
        <JointStage />
        <Showcase lang={lang} />
        <Simulate signedIn={signedIn} />
        <Closing />
      </main>
      <footer
        id="resources"
        className="relative z-[2] border-t border-border bg-background pt-7 pb-[calc(env(safe-area-inset-bottom,0px)+40px)]"
      >
        <div className="mx-auto flex w-full max-w-page flex-col gap-5 px-[clamp(16px,4vw,56px)]">
          <p className="font-mono text-[12px] text-muted-foreground">tenonfi · {t.foot}</p>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <LanguageSwitch />
            <ThemeSwitch initial={theme} keepSystem />
          </div>
        </div>
      </footer>
    </>
  );
}
