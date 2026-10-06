// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, press, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { LandingSignIn } from './LandingSignIn';

// The landing's "Sign in": the sign-in dialog over the landing, its panel loaded on the first press.
// The panel here is a stand-in, so the test sees the frame draw at once with a loading line, then the
// panel arrive in it.

const panel = vi.hoisted(() => ({ release: () => {}, loaded: 0 }));
vi.mock('./landing-sign-in-panel', async () => {
  panel.loaded += 1;
  await new Promise<void>((resolve) => {
    panel.release = resolve;
  });
  const { createElement: h } = await import('react');
  return {
    default: ({ titleId }: { titleId: string }) =>
      h('h2', { id: titleId, 'data-ui': 'panel-stand-in' }, 'the panel'),
  };
});

const en = dictionary('en');

afterEach(async () => {
  await unmountAll();
  document.documentElement.style.overflow = '';
});

describe('the landing’s Sign in', () => {
  it('opens the dialog over the landing at once, loads the panel into it, and gives focus back', async () => {
    const host = await mount(
      inLanguage(
        'en',
        createElement(
          'div',
          null,
          createElement('a', { href: '/sign-in?next=/goal', 'data-ui': 'cta' }, 'Sign in'),
          createElement(LandingSignIn),
        ),
      ),
    );
    // nothing is loaded before the press
    expect(panel.loaded).toBe(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const cta = find<HTMLAnchorElement>(host, '[data-ui="cta"]');
    cta.focus();
    await click(cta);
    const box = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(box?.getAttribute('aria-modal')).toBe('true');
    // the frame at once, named, with a quiet loading line and no blank
    const title = () => document.getElementById(box?.getAttribute('aria-labelledby') ?? '');
    expect(title()?.textContent).toBe(en.signIn.title);
    expect(box?.querySelector('[data-ui="sign-in-loading"]')?.textContent).toContain(
      en.signIn.loading,
    );
    expect(window.location.pathname).not.toBe('/sign-in');
    // the panel arrives in the same frame
    panel.release();
    await settle(10);
    await settle(10);
    expect(box?.querySelector('[data-ui="panel-stand-in"]')).not.toBeNull();
    expect(title()?.textContent).toBe('the panel');
    expect(panel.loaded).toBe(1);
    // Escape closes it, and focus goes back to the button pressed
    await press(box as HTMLElement, 'Escape');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(cta);
  });
});
