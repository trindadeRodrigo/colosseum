'use client';
import { useRouter } from 'next/navigation';
import { LANG_COOKIE, LANGS, type Lang, LOCALE } from '../../i18n';
import { useLang, useT } from '../../i18n/I18nProvider';
import { ChoiceChip } from './ChoiceChip';
import { remember } from './remember';

// English or Portuguese. The choice is a cookie the server reads, so the page is rendered in that
// language from the first byte; a press here stores it and asks the server for the page again.

/** Each language in its own words, whatever the language of the page. */
const NAME: Record<Lang, string> = { en: 'English', pt: 'Português' };

export function LanguageSwitch() {
  const t = useT();
  const lang = useLang();
  const router = useRouter();

  function choose(next: Lang) {
    if (next === lang) return;
    remember(LANG_COOKIE, next);
    router.refresh();
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: two toggle buttons are the group; a fieldset is for form controls
    <div
      role="group"
      aria-label={t.shell.language}
      data-ui="language-switch"
      className="flex flex-wrap items-center gap-2"
    >
      <span aria-hidden="true" className="text-caption text-muted-foreground">
        {t.shell.language}
      </span>
      {LANGS.map((option) => (
        <ChoiceChip
          key={option}
          lang={LOCALE[option]}
          chosen={lang === option}
          onChoose={() => choose(option)}
        >
          {NAME[option]}
        </ChoiceChip>
      ))}
    </div>
  );
}
