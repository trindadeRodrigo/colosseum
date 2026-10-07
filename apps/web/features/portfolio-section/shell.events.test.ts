// @vitest-environment happy-dom
import { DISCLAIMER } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary, type Lang } from '../../i18n';
import { portfolioDictionary } from '../../i18n/portfolio';
import { EMBEDDED, fakePort, signedInPort } from '../wallet/test/fake-port';
import { location } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { PlanPage } from './PlanPage';
import { href, METHODOLOGY, PAGES, pageOf, planHref, SECTION } from './pages';
import { RebalancingPage } from './RebalancingPage';
import { serve } from './test/api';
import { RH_SILENT, SOL_GROW } from './test/fixtures';
import { inFrame } from './test/screen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The frame of the portfolio section: the side menu with its own ids and its own memory, which page
// is current, the one disclaimer under the page, and the page that is not built yet, saying so
// inside the frame (the rebalancing and exposure pages have their own tests). Its own section: nothing of Bearing's is in it.

const frame = async (page: ReturnType<typeof createElement> | null, lang: Lang = 'en') => {
  const host = await mount(inFrame(lang, page));
  await settle();
  return host;
};
const signIn = (over: Parameters<typeof signedInPort>[1] = {}) =>
  portStore.set(signedInPort(EMBEDDED, over));
const menu = (host: HTMLElement) => find(host, '#portfolio-nav');
const current = (host: HTMLElement) =>
  [...menu(host).querySelectorAll('[aria-current="page"]')].map((a) => a.getAttribute('href'));

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  location.pathname = SECTION;
  portStore.set(fakePort());
  serve(portStore);
});
afterEach(unmountAll);

describe('the addresses of the section', () => {
  it('are the overview at /portfolio, a page a name under it, and a plan by its chain and vault', () => {
    expect(PAGES.map((p) => [p.id, href(p.id)])).toEqual([
      ['overview', '/portfolio'],
      ['rebalancing', '/portfolio/rebalancing'],
      ['exposure', '/portfolio/exposure'],
    ]);
    expect(href(METHODOLOGY)).toBe('/portfolio/methodology');
    expect(planHref('solana', SOL_GROW)).toBe(`/portfolio/plan/solana/${SOL_GROW}`);
    expect(planHref('robinhood', RH_SILENT)).toBe(`/portfolio/plan/robinhood/${RH_SILENT}`);
  });

  it('say which page an address is, and never one the section does not have', () => {
    expect(pageOf('/portfolio')).toBe('overview');
    expect(pageOf('/portfolio/')).toBe('overview');
    expect(pageOf('/portfolio/exposure')).toBe('exposure');
    expect(pageOf('/portfolio/rebalancing')).toBe('rebalancing');
    expect(pageOf('/portfolio/methodology')).toBe('methodology');
    expect(pageOf(planHref('solana', SOL_GROW))).toBe('plan');
    expect(pageOf('/portfolio/nothing')).toBe('overview');
    expect(pageOf('/monitor')).toBe('overview');
  });
});

describe('the frame of the portfolio section', () => {
  it.each(['en', 'pt'] as const)(
    'lists its pages in a side menu of its own, the methodology under them (%s)',
    async (lang) => {
      const w = portfolioDictionary(lang);
      const host = await frame(null, lang);
      const shell = find(host, '[data-ui="portfolio"]');
      // its own section: none of Bearing's marks
      expect(host.querySelector('[data-ui="bearing"], #bearing-nav')).toBeNull();
      // the menu's region; the other aside of the frame is the disclaimer
      expect(find(shell, ':scope > aside').getAttribute('aria-label')).toBe(w.shell.menu.region);
      expect(menu(host).getAttribute('aria-label')).toBe(w.shell.menu.nav);
      const links = [...menu(host).querySelectorAll('a')].map((a) => [
        a.getAttribute('href'),
        // the two letters before a name are for the eye only
        [...a.querySelectorAll('span:not([aria-hidden])')].map((s) => s.textContent).join('') ||
          a.textContent,
      ]);
      expect(links).toEqual([
        ['/portfolio', w.overview.label],
        ['/portfolio/rebalancing', w.rebalancing.label],
        ['/portfolio/exposure', w.exposure.label],
        ['/portfolio/methodology', w.methodology.label],
      ]);
      // a plan's page is opened from its card, never from the menu
      expect(menu(host).querySelector('a[href*="/plan/"]')).toBeNull();
    },
  );

  it('marks the page the address names as the current one', async () => {
    for (const [path, at] of [
      ['/portfolio', ['/portfolio']],
      ['/portfolio/rebalancing', ['/portfolio/rebalancing']],
      ['/portfolio/exposure', ['/portfolio/exposure']],
      ['/portfolio/methodology', ['/portfolio/methodology']],
      // a plan's page is under no item of the menu
      [planHref('solana', SOL_GROW), []],
    ] as const) {
      location.pathname = path;
      const host = await frame(null);
      expect(current(host), path).toEqual(at);
      await unmountAll();
    }
  });

  it('hides its menu to a rail and shows it again, says so, and remembers it under its own key', async () => {
    const host = await frame(null);
    const toggle = find<HTMLButtonElement>(host, 'button[aria-controls="portfolio-nav"]');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Hide menu');
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Show menu');
    expect(find(host, '[data-ui="portfolio"]').hasAttribute('data-collapsed')).toBe(true);
    expect(localStorage.getItem('tf-portfolio-side')).toBe('1');
    // Bearing's menu keeps its own memory
    expect(localStorage.getItem('tf-an2-side')).toBeNull();
    await unmountAll();
    // opened again, it is as it was left
    const again = await frame(null);
    expect(find(again, 'button[aria-controls="portfolio-nav"]').getAttribute('aria-expanded')).toBe(
      'false',
    );
    await click(find(again, 'button[aria-controls="portfolio-nav"]'));
    expect(localStorage.getItem('tf-portfolio-side')).toBe('0');
  });

  it.each(['en', 'pt'] as const)(
    'puts the disclaimer under the page, once, from the one constant (%s)',
    async (lang) => {
      const host = await frame(createElement(RebalancingPage), lang);
      const block = find(host, '[data-ui="disclaimer"]');
      expect(find(block, 'p[lang]').textContent).toBe(DISCLAIMER[lang]);
      expect(block.getAttribute('aria-label')).toBe(dictionary(lang).shell.disclaimer);
      expect(block.textContent).toContain(portfolioDictionary(lang).shell.notAdvice);
      // after the page, and not inside it
      const page = find(host, '[data-ui="portfolio-page"]');
      expect(page.contains(block)).toBe(false);
      expect(page.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // a page that carries its own under what it shows has it once: this one is then not drawn, by
      // a rule of the stylesheet, as the app's foot does
      expect(block.className).toContain(
        'group-has-[[data-ui=portfolio-page]_[data-ui=disclaimer]]/portfolio:hidden',
      );
      expect(find(host, '[data-ui="portfolio"]').className).toContain('group/portfolio');
    },
  );
});

describe('the page that is not built yet', () => {
  const pages = [
    [
      'plan',
      () => createElement(PlanPage, { chain: 'solana', address: SOL_GROW }),
      'portfolio-plan',
    ],
  ] as const;

  it.each(['en', 'pt'] as const)(
    'each say their title and that they are not built, and show nothing else (%s)',
    async (lang) => {
      const w = portfolioDictionary(lang);
      for (const signedIn of [false, true]) {
        for (const [id, page, ui] of pages) {
          if (signedIn) signIn();
          const host = await frame(page(), lang);
          const root = find(host, `[data-ui="${ui}"]`);
          expect(find(root, 'h1').textContent, id).toBe(w[id].title);
          // the serif is spent once, on the title
          expect(host.querySelectorAll('.font-display')).toHaveLength(1);
          expect(root.textContent).toContain(w.shell.soon);
          // no figure made up in the page's place, and nothing to sign
          expect(host.querySelector('[data-ui="figure"]')).toBeNull();
          expect(host.querySelector('[data-variant="primary"]')).toBeNull();
          expect(host.querySelector('table')).toBeNull();
          await unmountAll();
          portStore.set(fakePort());
        }
      }
    },
  );

  it('hands a plan’s page the chain and the vault its address names', async () => {
    const host = await frame(createElement(PlanPage, { chain: 'robinhood', address: RH_SILENT }));
    const root = find(host, '[data-ui="portfolio-plan"]');
    expect([root.getAttribute('data-chain'), root.getAttribute('data-address')]).toEqual([
      'robinhood',
      RH_SILENT,
    ]);
  });
});
