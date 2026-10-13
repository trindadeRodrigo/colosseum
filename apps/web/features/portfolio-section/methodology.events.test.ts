// @vitest-environment happy-dom
import { DISCLAIMER, TRACK_RULE, TrackLine } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import type { Lang } from '../../i18n';
import { portfolioDictionary } from '../../i18n/portfolio';
import { EMBEDDED, fakePort, signedInPort } from '../wallet/test/fake-port';
import { location } from '../wallet/test/mock-next';
import { portStore } from '../wallet/test/mock-provider';
import { EXPOSURE_PATH, PLANS_PATH, REBALANCES_PATH } from './api';
import { MethodologyPage } from './MethodologyPage';
import { serve } from './test/api';
import { STATUS_BY_LINE } from './test/fixtures';
import { inFrame } from './test/screen';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// The methodology of the portfolio section: what a snapshot is, what each status means with the
// rule's name and every line of it in the order it is tried, where each figure comes from, what the
// pages cannot say yet, and the disclaimer once under it. Plain text: no figure, so no pin.

const methodology = async (lang: Lang = 'en') => {
  const host = await mount(inFrame(lang, createElement(MethodologyPage)));
  await settle();
  return host;
};
const text = (el: Element) => el.textContent ?? '';
const signIn = (over: Parameters<typeof signedInPort>[1] = {}) =>
  portStore.set(signedInPort(EMBEDDED, over));

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  location.pathname = '/portfolio/methodology';
  portStore.set(fakePort());
  serve(portStore);
});
afterEach(unmountAll);

describe.each(['en', 'pt'] as const)('the methodology (%s)', (lang) => {
  const w = portfolioDictionary(lang);
  const m = w.methodology;

  it('opens on its title, the one serif line, with the menu on it', async () => {
    const host = await methodology(lang);
    expect(text(find(host, 'h1'))).toBe(m.title);
    expect(host.querySelectorAll('.font-display')).toHaveLength(1);
    expect(find(host, '.font-display').tagName).toBe('H1');
    expect(find(host, '#portfolio-nav [aria-current="page"]').getAttribute('href')).toBe(
      '/portfolio/methodology',
    );
    expect([...host.querySelectorAll('h2')].map(text)).toEqual([
      m.snapshot.heading,
      m.status.heading,
      m.sources.heading,
      m.cannot.heading,
    ]);
  });

  it('says what a snapshot is and how often one is taken', async () => {
    const host = await methodology(lang);
    const page = text(find(host, '[data-ui="portfolio-methodology"]'));
    for (const paragraph of m.snapshot.body) expect(page).toContain(paragraph);
    expect(m.snapshot.body.join(' ')).toMatch(lang === 'en' ? /every ten minutes/ : /dez minutos/);
    expect(m.snapshot.body.join(' ')).toMatch(lang === 'en' ? /holds no key/ : /não tem chave/);
  });

  it('names the rule by its constant, and says what each status means with its shape', async () => {
    const host = await methodology(lang);
    expect(text(find(host, '[data-ui="rule-name"]'))).toBe(m.status.intro(TRACK_RULE));
    expect(text(find(host, '[data-ui="rule-name"]'))).toContain('ON-TRACK-V1');
    const legend = find(host, '[data-ui="status-legend"]');
    const rows = [...legend.querySelectorAll('[data-word]')].map((row) => [
      row.getAttribute('data-word'),
      row.querySelector('[data-ui="status"]')?.getAttribute('data-status') ?? null,
      text(find(row, 'dt')),
      text(find(row, 'dd')),
    ]);
    expect(rows).toEqual([
      ['on_track', 'on-track', w.status.words.on_track, m.status.means.on_track],
      ['watch', 'watch', w.status.words.watch, m.status.means.watch],
      ['off_track', 'off-track', w.status.words.off_track, m.status.means.off_track],
      ['none', null, w.status.none, m.status.means.none],
    ]);
    // a status is a word and a shape
    expect(legend.querySelectorAll('svg[data-ui="status-mark"]')).toHaveLength(3);
    // and it says what the status does not say: nothing yet of the goal's amount or date
    expect(text(host)).toContain(m.status.goal);
    expect(text(host)).toContain(m.status.notForecast);
  });

  it('names every line of the rule, in the order it is tried, with what the line gives', async () => {
    const host = await methodology(lang);
    const lines = [...find(host, '[data-ui="rule-lines"]').querySelectorAll('li')];
    // every line of the contract, and in its order: the first that holds gives the status
    expect(lines.map((li) => li.getAttribute('data-line'))).toEqual([...TrackLine.options]);
    expect(find(host, '[data-ui="rule-lines"]').tagName).toBe('OL');
    for (const li of lines) {
      const line = li.getAttribute('data-line') as TrackLine;
      expect(text(li)).toContain(m.status.lines[line]);
      // what the page says a line gives is what the rule answers for it
      const answered = new Set(STATUS_BY_LINE[line].map((status) => status.status));
      const mark = li.querySelector('[data-ui="status"]');
      if (line === 'verdict') {
        // a verdict hands the status over: the line names none of its own
        expect(mark).toBeNull();
        expect(text(li)).toContain(m.status.asVerdict);
      } else {
        expect(answered.size, line).toBe(1);
        const [status] = answered;
        if (status === null) {
          expect(mark, line).toBeNull();
          expect(text(li)).toContain(w.status.none);
        } else {
          expect(mark?.getAttribute('data-status'), line).toBe(
            status === undefined ? '' : status.replace('_', '-'),
          );
          expect(text(mark as Element)).toBe(status ? w.status.words[status] : '');
        }
      }
    }
    expect(text(host)).toContain(m.status.first);
  });

  it('says where each figure comes from, and what the pages cannot say yet', async () => {
    const host = await methodology(lang);
    const page = text(find(host, '[data-ui="portfolio-methodology"]'));
    for (const [term, said] of [...m.status.terms, ...m.sources.items]) {
      expect(page).toContain(`${term}: ${said}`);
    }
    expect(m.sources.items).toHaveLength(8);
    for (const said of m.cannot.items) expect(page).toContain(said);
    expect(m.cannot.items.length).toBeGreaterThanOrEqual(10);
    expect(page).toContain(m.sources.pin);
  });

  it('is plain text: no figure, no pin, nothing to press but the menu', async () => {
    const host = await methodology(lang);
    const page = find(host, '[data-ui="portfolio-methodology"]');
    expect(
      page.querySelector(
        '[data-ui="figure"], [data-ui="pin"], table, svg:not([data-ui="status-mark"])',
      ),
    ).toBeNull();
    expect(page.querySelector('button, a, input')).toBeNull();
    // no amount of money, no rate and no share is written on it
    expect(text(page)).not.toMatch(/[$%]|US\$|\d+[.,]\d+/);
  });

  it('says none of it is advice with the disclaimer, once, from the one constant', async () => {
    const host = await methodology(lang);
    const blocks = [...host.querySelectorAll('[data-ui="disclaimer"]')];
    expect(blocks).toHaveLength(1);
    const [block] = blocks as [Element];
    expect(text(find(block, 'p[lang]'))).toBe(DISCLAIMER[lang]);
    expect(text(block)).toContain(w.shell.notAdvice);
    // the page points to it and does not say it in its own words
    const page = find(host, '[data-ui="portfolio-methodology"]');
    expect(text(find(page, '[data-ui="methodology-boundary"]'))).toBe(m.boundary);
    expect(text(page)).not.toContain(DISCLAIMER[lang]);
    expect(page.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the methodology and the reads', () => {
  it('reads the same signed in or out: it shows nothing of the person', async () => {
    const out = await methodology();
    const signedOut = text(find(out, '[data-ui="portfolio-methodology"]'));
    await unmountAll();
    const server = serve(portStore);
    signIn();
    const host = await methodology();
    expect(text(find(host, '[data-ui="portfolio-methodology"]'))).toBe(signedOut);
    // the section's reads are the provider's, asked once whatever page is open
    for (const route of [PLANS_PATH, EXPOSURE_PATH, REBALANCES_PATH])
      expect(server.to(route)).toHaveLength(1);
  });
});
