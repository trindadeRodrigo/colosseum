// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { inLanguage } from '../account/test/screen';
import { LandingAccount } from './LandingAccount';

vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The landing's account control for a person signed in on this browser (the hint), before the
// wallet's code is there: the chip's still box, never "Sign in", and the wallet loaded at once with
// no press. In a file of its own: the stand-in is loaded once per file.

const live = vi.hoisted(() => ({ release: () => {}, loaded: 0 }));
vi.mock('./landing-account-live', async () => {
  live.loaded += 1;
  await new Promise<void>((resolve) => {
    live.release = resolve;
  });
  const { createElement: h } = await import('react');
  return { default: () => h('span', { 'data-ui': 'live-control' }, 'live') };
});

const bar = (hinted = false) => mount(inLanguage('en', createElement(LandingAccount, { hinted })));

afterEach(unmountAll);

it('is the chip’s still box for a person signed in on this browser, whose wallet is loaded at once', async () => {
  const host = await bar(true);
  await settle(10);
  // no press was needed, and "Sign in" is never shown to them while it loads
  expect(live.loaded).toBe(1);
  const control = find(host, '[data-ui="account-control"]');
  expect(control.getAttribute('data-state')).toBe('loading');
  const box = find(control, '[data-ui="account-placeholder"]');
  expect(box.getAttribute('data-shape')).toBe('account');
  expect(box.getAttribute('aria-hidden')).toBe('true');
  expect(host.querySelector('a')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  live.release();
  await settle(10);
  await settle(10);
  expect(host.querySelector('[data-ui="live-control"]')).not.toBeNull();
  expect(host.querySelector('[data-ui="account-placeholder"]')).toBeNull();
});
