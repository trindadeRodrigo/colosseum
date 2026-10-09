'use client';
import { THEME_CLASS, THEME_COOKIE } from '../../i18n';
import { useT } from '../../i18n/I18nProvider';
import { cn } from '../ui/cn';
import { remember } from './remember';

// Light or dark, as one icon in the top bar (Rodrigo, Oct 8: "make the appearance an icon in the top
// menu"). It shows the sun on a dark page and the moon on a light one, chosen by the stylesheet from
// the class the server wrote (the `drawn-dark` variant in globals.css), so the first paint is already
// right with no script. A press flips what is drawn now, changes the class at once, and stores the
// choice for the next page. With no choice made the page follows the system until the first press.

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function Sun() {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="3.5" />
      <path d="M10 1.75v2M10 16.25v2M1.75 10h2M16.25 10h2M4.17 4.17l1.41 1.41M14.42 14.42l1.41 1.41M4.17 15.83l1.41-1.41M14.42 5.58l1.41-1.41" />
    </svg>
  );
}

function Moon() {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16.5 12.4A7 7 0 0 1 7.6 3.5a7 7 0 1 0 8.9 8.9Z" />
    </svg>
  );
}

/** Whether the page is drawn dark now: the dark class, or no choice on a dark system. */
function drawnDark(root: HTMLElement): boolean {
  if (root.classList.contains('dark')) return true;
  if (root.classList.contains('light')) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeToggle({ className }: { className?: string }) {
  const t = useT().shell;
  function flip() {
    const root = document.documentElement;
    const next = drawnDark(root) ? 'light' : 'dark';
    root.classList.remove(...Object.values(THEME_CLASS));
    root.classList.add(THEME_CLASS[next]);
    remember(THEME_COOKIE, next);
  }
  return (
    <button
      type="button"
      data-ui="theme-toggle"
      onClick={flip}
      className={cn(
        'grid size-10 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        FOCUS,
        className,
      )}
    >
      <span className="hidden drawn-dark:contents">
        <span className="sr-only">{t.toLight}</span>
        <Sun />
      </span>
      <span className="contents drawn-dark:hidden">
        <span className="sr-only">{t.toDark}</span>
        <Moon />
      </span>
    </button>
  );
}
