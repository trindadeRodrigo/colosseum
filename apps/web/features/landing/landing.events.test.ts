// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary, type Lang } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { Landing } from './Landing';
import { fromReply, type PlatformStats, platformStats, SAMPLE_STATS } from './stats';

vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// His landing page on the new identity (IDENTITY-2): the hero is the whole page. A static bar, the
// line and "Start a plan" in front, the slow honey fog behind, and the platform's numbers, each pinned.

const en = dictionary('en');
const LIVE_REPLY = {
  plans: 37,
  wallets: 12,
  observedValueUsd: 15234.5,
  asOf: '2026-10-08T12:00:00.000Z',
};

const landing = async (
  { lang = 'en', signedIn = false, stats = SAMPLE_STATS } = {} as {
    lang?: Lang;
    signedIn?: boolean;
    stats?: PlatformStats;
  },
) => {
  const host = await mount(inLanguage(lang, createElement(Landing, { lang, signedIn, stats })));
  await settle(10);
  return host;
};

beforeEach(() => {
  // no WebGL here: the fog stays empty and the page is whole without it
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null as never);
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('the hero', () => {
  it.each(['en', 'pt'] as const)('is the line, the lead and the two actions (%s)', async (lang) => {
    const t = dictionary(lang).landing.hero;
    const host = await landing({ lang });
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(find(host, 'h1').textContent).toBe(t.title);
    expect(host.textContent).toContain(t.lead);
    const hero = find(host, '[data-ui="landing-hero"]');
    const actions = [...hero.querySelectorAll('a')].map((a) => [
      a.textContent,
      a.getAttribute('href'),
    ]);
    expect(actions).toEqual([
      [t.start, '/goal'],
      [t.see, '/shelf'],
    ]);
  });

  it('starts a plan with the filled honey action, and shows a plan with the outlined one', async () => {
    const host = await landing();
    const [start, see] = [...find(host, '[data-ui="landing-hero"]').querySelectorAll('a')];
    expect(start?.className).toContain('bg-primary');
    expect(see?.className).not.toContain('bg-primary');
  });

  it('draws the fog behind the copy, out of the way of a reader and a pointer', async () => {
    const host = await landing();
    const fog = find(host, '[data-ui="landing-hero"] [data-ui="honey-fog"]');
    expect(fog.getAttribute('aria-hidden')).toBe('true');
    expect(fog.className).toContain('pointer-events-none');
  });

  it('is the whole page: no stage, showcase, typing box or closing under it', async () => {
    const host = await landing();
    const main = find(host, 'main');
    expect([...main.children].map((c) => c.getAttribute('data-ui'))).toEqual([
      'landing-hero',
      'landing-stats',
    ]);
    expect(host.querySelectorAll('textarea, input[type="email"]')).toHaveLength(0);
  });
});

describe('the bar', () => {
  it('is static: the face and the wordmark home, Plans, Bearing, Docs, and one action', async () => {
    const host = await landing();
    const bar = find(host, '[data-ui="landing-bar"]');
    expect(find(bar, 'a[href="/"]').getAttribute('aria-label')).toBe(en.landing.nav.home);
    expect(bar.textContent).toContain('tenonfi');
    expect([...bar.querySelectorAll('nav a')].map((a) => a.textContent)).toEqual([
      en.landing.nav.plans,
      en.landing.nav.bearing,
      en.landing.nav.docs,
    ]);
    expect(bar.className).not.toMatch(/\b(fixed|sticky)\b/);
  });

  it('asks a visitor to sign in, and leads a person signed in back into the app', async () => {
    const visitor = await landing();
    expect(
      [...find(visitor, '[data-ui="landing-bar"]').querySelectorAll('a')]
        .at(-1)
        ?.getAttribute('href'),
    ).toBe('/sign-in?next=/goal');
    await unmountAll();
    const back = await landing({ signedIn: true });
    const action = [...find(back, '[data-ui="landing-bar"]').querySelectorAll('a')].at(-1);
    expect(action?.textContent).toBe(en.landing.nav.openApp);
    expect(action?.getAttribute('href')).toBe('/goal');
    expect(back.querySelector('a[href^="/sign-in"]')).toBeNull();
  });
});

describe('the numbers', () => {
  it('pins every figure, and marks a sample strip with the hatch and its quiet line', async () => {
    const host = await landing();
    const strip = find(host, '[data-ui="landing-stats"]');
    expect(strip.hasAttribute('data-sample')).toBe(true);
    expect(strip.querySelectorAll('dt')).toHaveLength(3);
    expect(strip.querySelectorAll('[data-ui="pin-glyph"][data-state="mock"]')).toHaveLength(3);
    expect(strip.querySelector('[data-ui="hatch-band"]')).not.toBeNull();
    expect(find(strip, '[data-ui="sample-note"]').textContent).toBe(en.shell.mockAnnounce);
    // the word MOCK never shows (MOCK-QUIET)
    expect(host.textContent).not.toContain('MOCK');
  });

  it('shows the API’s numbers live on mainnet, with no hatch and no change figure', async () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'mainnet');
    const stats = fromReply(LIVE_REPLY);
    expect(stats).not.toBeNull();
    const host = await landing({ stats: stats ?? SAMPLE_STATS });
    const strip = find(host, '[data-ui="landing-stats"]');
    expect(strip.hasAttribute('data-sample')).toBe(false);
    expect(strip.querySelector('[data-ui="hatch-band"]')).toBeNull();
    expect(strip.querySelectorAll('[data-ui="pin-glyph"][data-state="live"]')).toHaveLength(3);
    expect([...strip.querySelectorAll('dt')].map((d) => d.textContent)).toEqual([
      en.landing.stats.plans,
      en.landing.stats.wallets,
      en.landing.stats.value,
    ]);
    expect(strip.textContent).toContain('37');
    expect(strip.textContent).not.toMatch(/[+−]\d/);
  });

  it('says "Test network" on the API’s numbers off mainnet, and keeps the hatch', async () => {
    vi.stubEnv('NEXT_PUBLIC_CHAIN_NETWORK_SOLANA', 'devnet');
    const host = await landing({ stats: fromReply(LIVE_REPLY) ?? SAMPLE_STATS });
    const strip = find(host, '[data-ui="landing-stats"]');
    expect(strip.hasAttribute('data-sample')).toBe(true);
    expect(find(strip, '[data-ui="sample-note"]').textContent).toBe(en.shell.testNetworkLine);
  });
});

describe('where the numbers come from', () => {
  it('is the sample strip when the API does not answer, or answers with something else', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    expect(await platformStats()).toBe(SAMPLE_STATS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200 }));
    expect(await platformStats()).toBe(SAMPLE_STATS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('no', { status: 500 }));
    expect(await platformStats()).toBe(SAMPLE_STATS);
  });

  it('is the API’s `/stats`, stamped with the instant it answered', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(LIVE_REPLY));
    const stats = await platformStats();
    expect(stats.live).toBe(true);
    for (const item of stats.items) {
      expect(item.obs.source).toBe('tenonfi API /stats');
      expect(item.obs.fetchedAt).toBe(LIVE_REPLY.asOf);
      expect(item.obs.method).not.toBe('');
    }
  });
});

describe('the landing’s type', () => {
  const classesOf = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>('[class]')].map((el) => el.getAttribute('class') ?? '');

  it('sets nothing under 12px', async () => {
    const host = await landing();
    expect(classesOf(host).filter((c) => /text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/.test(c))).toEqual(
      [],
    );
  });

  it('keeps every line height on the 4px grid: no bare ratio, a fluid size rounds to 4px', async () => {
    const host = await landing();
    expect(classesOf(host).filter((c) => /\/\[\d+(?:\.\d+)?\](?:\s|$)/.test(c))).toEqual([]);
    for (const c of classesOf(host).filter((c) => c.includes('round(')))
      expect(c).toMatch(/round\(\d+(?:\.\d+)?em,4px\)/);
  });
});
