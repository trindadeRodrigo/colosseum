// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, press, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { LandingAccount } from './LandingAccount';

vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The landing's account control before the wallet's code is there: "Sign in" at once for a visitor,
// with nothing loaded until the first press; the sign-in dialog's frame at once on that press, and
// the panel arriving in the same frame. A person signed in on this browser is in
// landing-account.hinted.events.test.ts. What is loaded here is a stand-in; the real one is in
// landing-account.live.events.test.ts.

const live = vi.hoisted(() => ({ release: () => {}, loaded: 0 }));
vi.mock('./landing-account-live', async () => {
  live.loaded += 1;
  await new Promise<void>((resolve) => {
    live.release = resolve;
  });
  const { createElement: h, Fragment } = await import('react');
  const { createPortal } = await import('react-dom');
  return {
    default: ({ panel, titleId }: { panel: HTMLElement | null; titleId: string | null }) =>
      h(
        Fragment,
        null,
        h('a', { href: '/sign-in', 'data-ui': 'live-control', 'data-account-focus': '' }, 'live'),
        panel &&
          createPortal(h('h2', { id: titleId, 'data-ui': 'panel-stand-in' }, 'the panel'), panel),
      ),
  };
});

const en = dictionary('en');
const bar = (hinted = false) => mount(inLanguage('en', createElement(LandingAccount, { hinted })));

afterEach(async () => {
  await unmountAll();
  document.documentElement.style.overflow = '';
});

describe('the landing’s account control, before the wallet is loaded', () => {
  it('is "Sign in" at once for a visitor, outlined, with nothing loaded', async () => {
    const host = await bar();
    await settle(10);
    expect(live.loaded).toBe(0);
    const control = find(host, '[data-ui="account-control"]');
    expect(control.getAttribute('data-state')).toBe('signed-out');
    const way = find<HTMLAnchorElement>(control, 'a');
    expect([way.textContent, way.getAttribute('href')]).toEqual([en.shell.signIn, '/sign-in']);
    // the landing's filled action is the hero's: one primary button per view
    expect(way.className).not.toContain('bg-primary');
    expect(way.className).toContain('h-10');
    expect(control.querySelector('[data-ui="account-placeholder"]')).toBeNull();
  });

  it('opens the dialog over the landing at once, loads the panel into it, and gives focus back', async () => {
    const host = await bar();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const way = find<HTMLAnchorElement>(host, '[data-ui="account-control"] a');
    way.focus();
    await click(way);
    const box = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(box?.getAttribute('aria-modal')).toBe('true');
    // the frame at once, named, with a quiet loading line and no blank
    const title = () => document.getElementById(box?.getAttribute('aria-labelledby') ?? '');
    expect(title()?.textContent).toBe(en.signIn.title);
    expect(box?.querySelector('[data-ui="sign-in-loading"]')?.textContent).toContain(
      en.signIn.loading,
    );
    expect(window.location.pathname).not.toBe('/sign-in');
    // the panel arrives in the same frame, which was not drawn again
    live.release();
    await settle(10);
    await settle(10);
    expect(document.querySelector('[role="dialog"]')).toBe(box);
    expect(box?.querySelector('[data-ui="panel-stand-in"]')).not.toBeNull();
    expect(title()?.textContent).toBe('the panel');
    expect(live.loaded).toBe(1);
    // the live control took the static one's place
    expect(way.isConnected).toBe(false);
    const control = find(host, '[data-ui="live-control"]');
    // Escape closes it, and focus goes to the control that took the place of the button pressed
    await press(box as HTMLElement, 'Escape');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(control);
    // the next press opens it with the panel there at once, and nothing is loaded twice
    await click(control);
    expect(document.querySelector('[role="dialog"] [data-ui="panel-stand-in"]')).not.toBeNull();
    expect(live.loaded).toBe(1);
  });
});
