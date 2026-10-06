'use client';
import { useState } from 'react';
import { THEME_CLASS, THEME_COOKIE, type ThemeChoice } from '../../i18n';
import { useT } from '../../i18n/I18nProvider';
import { ChoiceChip } from './ChoiceChip';
import { remember } from './remember';

// Light, dark, or whatever the system is. The server writes the class on <html> from the cookie, so a
// page never paints in one and then turns into the other; with no choice made, `tf-auto` lets the
// stylesheet follow the system (globals.css). A press here changes the class at once and stores the
// choice for the next page.

const CHOICES: readonly ThemeChoice[] = ['auto', 'light', 'dark'];

export function ThemeSwitch({
  initial,
  keepSystem = false,
}: {
  initial: ThemeChoice;
  /**
   * Stores "System" as a choice of its own, for a page whose default is not the system (the landing
   * is dark unless the visitor chose): with nothing stored, that page would be dark again.
   */
  keepSystem?: boolean;
}) {
  const t = useT();
  const [choice, setChoice] = useState(initial);

  function choose(next: ThemeChoice) {
    setChoice(next);
    const root = document.documentElement;
    root.classList.remove(...Object.values(THEME_CLASS));
    root.classList.add(THEME_CLASS[next]);
    remember(THEME_COOKIE, next === 'auto' && !keepSystem ? null : next);
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: three toggle buttons are the group; a fieldset is for form controls
    <div
      role="group"
      aria-label={t.shell.appearance}
      data-ui="theme-switch"
      className="flex flex-wrap items-center gap-2"
    >
      <span aria-hidden="true" className="text-caption text-muted-foreground">
        {t.shell.appearance}
      </span>
      {CHOICES.map((option) => (
        <ChoiceChip key={option} chosen={choice === option} onChoose={() => choose(option)}>
          {t.shell.themes[option]}
        </ChoiceChip>
      ))}
    </div>
  );
}
