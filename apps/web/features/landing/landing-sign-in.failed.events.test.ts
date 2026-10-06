// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { LandingSignIn } from './LandingSignIn';

// The landing's sign-in panel that does not load (offline, or a deploy moved its chunk): the dialog
// says so and leads to the page, which the landing's own click handler lets through.

vi.mock('./landing-sign-in-panel', () => {
  throw new Error('Loading chunk failed');
});

const en = dictionary('en');

afterEach(async () => {
  await unmountAll();
  document.documentElement.style.overflow = '';
});

it('says the sign-in did not load, and leads to the sign-in page', async () => {
  const host = await mount(
    inLanguage(
      'en',
      createElement(
        'div',
        null,
        createElement('a', { href: '/sign-in', 'data-ui': 'cta' }, 'Sign in'),
        createElement(LandingSignIn),
      ),
    ),
  );
  await click(find<HTMLAnchorElement>(host, '[data-ui="cta"]'));
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
});
