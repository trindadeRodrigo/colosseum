// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { LandingAccount } from './LandingAccount';

vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The landing's wallet and sign-in panel that do not load (offline, or a deploy moved the chunk): the
// dialog says so and leads to the page, which the landing's own click handler lets through; and a
// person the hint names is not left with a still box for good.

vi.mock('./landing-account-live', () => {
  throw new Error('Loading chunk failed');
});

const en = dictionary('en');

afterEach(async () => {
  await unmountAll();
  document.documentElement.style.overflow = '';
});

it('says the sign-in did not load, and leads to the sign-in page', async () => {
  const host = await mount(inLanguage('en', createElement(LandingAccount)));
  const way = find<HTMLAnchorElement>(host, '[data-ui="account-control"] a');
  await click(way);
  for (let i = 0; i < 4; i += 1) await settle(10);
  const box = document.querySelector<HTMLElement>('[role="dialog"]');
  const alert = box?.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain(en.signIn.notLoaded);
  expect(box?.textContent).not.toContain(en.signIn.loading);
  const page = alert?.querySelector<HTMLAnchorElement>('a');
  expect([page?.textContent, page?.getAttribute('href')]).toEqual([en.signIn.openPage, '/sign-in']);
  // the landing does not catch this one: a plain press goes to the page
  const press = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  page?.dispatchEvent(press);
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(press.defaultPrevented).toBe(false);
  // the bar's "Sign in" is still the one that was pressed
  expect(way.isConnected).toBe(true);
});

it('gives a person the hint names "Sign in" when their wallet did not load, not a still box for good', async () => {
  const host = await mount(inLanguage('en', createElement(LandingAccount, { hinted: true })));
  for (let i = 0; i < 4; i += 1) await settle(10);
  const control = find(host, '[data-ui="account-control"]');
  expect(control.getAttribute('data-state')).toBe('signed-out');
  expect(find(control, 'a').textContent).toBe(en.shell.signIn);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
