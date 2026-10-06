// @vitest-environment happy-dom
import { DISCLAIMER } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { find, mount, press, settle, type, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { READ_IN_DOLLARS } from '../goal/test/plan';
import { chainOf, price, SECOND_VAULT, VAULT, vault } from '../portfolio/test/portfolio';
import { EmbedGoal } from './EmbedGoal';
import { EmbedVault } from './EmbedVault';
import { HEIGHT_MESSAGE, HEIGHT_REQUEST } from './host-height';
import { partnerTheme, themeStyle } from './theme';

// The partner embed with real events (embed-shell.md, guidelines.html section 08): in the partner's
// skin, a goal read into limits and the way out to build the plan in tenonfi; a vault read only. No
// bar, no wallet, nothing that signs; the pin, MOCK, the disclaimer and the credit stay.

const en = dictionary('en');
const SAMPLE = partnerTheme({
  fg: '#1E1E1E',
  bg: '#FFFFFF',
  muted: '#6A6A6A',
  border: '#E4E4E4',
  accent: '#1E1E1E',
  radius: '14px',
  font: 'system-ui',
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let calls: { url: string; method: string; body?: string }[] = [];
function api(answer: (url: string) => Response) {
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    return answer(url);
  });
}

const goal = (lang: Lang = 'en') =>
  mount(inLanguage(lang, createElement(EmbedGoal, { style: themeStyle(SAMPLE) })));
const shell = (host: HTMLElement) => find(host, '[data-ui="embed-shell"]');

beforeEach(() => {
  window.sessionStorage.clear();
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
});

describe('the embed’s goal', () => {
  it('is a section in the partner’s skin, with no bar, no wallet, no serif and nothing that signs', async () => {
    api(() => json({}, 404));
    const host = await goal();
    const section = shell(host);
    expect(section.tagName).toBe('SECTION');
    expect(section.getAttribute('aria-label')).toBe(en.embed.label);
    // the host owns the landmarks
    expect(host.querySelector('main, header, nav')).toBeNull();
    expect(host.querySelector('.font-display')).toBeNull();
    // the partner's colours and radius are on the frame, for the shell to read
    const frame = find(host, '[data-ui="embed-frame"]');
    expect(frame.style.getPropertyValue('--embed-bg')).toBe('#FFFFFF');
    expect(frame.style.getPropertyValue('--embed-radius')).toBe('14px');
    // the disclaimer, whole, and the credit
    expect(find(section, '[data-ui="disclaimer"] p').textContent).toBe(DISCLAIMER.en);
    expect(find(section, '[data-ui="embed-credit"]').textContent).toContain(en.embed.poweredBy);
    expect(host.textContent).not.toMatch(/sign (and|this)|connect wallet/i);
  });

  it('reads the goal with the public reader, shows the limits, and leads out to build the plan in tenonfi', async () => {
    api((url) => (url.endsWith('/goals') ? json(READ_IN_DOLLARS) : json({}, 404)));
    const host = await goal();
    const box = find<HTMLTextAreaElement>(host, 'textarea');
    await type(box, 'Grow $40,000 for 36 months, medium risk');
    await press(box, 'Enter');
    await find<HTMLFormElement>(host, 'form').requestSubmit();
    await settle();
    // one call, to the reader that needs no sign-in, and no other route
    expect(calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([['POST', '/goals']]);
    const limits = find(host, `section[aria-label="${en.embed.limits}"]`);
    expect(limits.querySelectorAll('dl > div')).toHaveLength(4);
    const out = find<HTMLAnchorElement>(limits, 'a');
    expect(out.textContent).toBe(en.embed.build);
    expect(out.getAttribute('target')).toBe('_blank');
    // the goal goes in the fragment, which no server sees
    expect(out.getAttribute('href')).toBe(
      `/goal#goal=${encodeURIComponent('Grow $40,000 for 36 months, medium risk')}`,
    );
    expect(limits.textContent).toContain(en.embed.buildNote);
  });

  it('says a failed reading in a sentence, and keeps the text', async () => {
    api(() => {
      throw new TypeError('fetch failed');
    });
    const host = await goal();
    const box = find<HTMLTextAreaElement>(host, 'textarea');
    await type(box, 'Grow $40,000 for 36 months');
    await find<HTMLFormElement>(host, 'form').requestSubmit();
    await settle();
    expect(find(host, '[role="alert"]').textContent).toBe(en.embed.readFailure);
    expect(box.value).toBe('Grow $40,000 for 36 months');
  });

  it('tells its host how tall it is, when it sits in a frame', async () => {
    api(() => json({}, 404));
    const post = vi.fn();
    const parent = Object.getOwnPropertyDescriptor(window, 'parent');
    Object.defineProperty(window, 'parent', { configurable: true, value: { postMessage: post } });
    try {
      await goal();
      expect(post).toHaveBeenCalledWith({ type: HEIGHT_MESSAGE, height: expect.any(Number) }, '*');
      // a host that missed it asks, and is told again; anyone else asking is not answered
      post.mockClear();
      window.dispatchEvent(new MessageEvent('message', { data: { type: HEIGHT_REQUEST } }));
      expect(post).not.toHaveBeenCalled();
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: HEIGHT_REQUEST },
          source: window.parent as unknown as Window,
        }),
      );
      expect(post).toHaveBeenCalledWith({ type: HEIGHT_MESSAGE, height: expect.any(Number) }, '*');
    } finally {
      if (parent) Object.defineProperty(window, 'parent', parent);
    }
  });

  it('speaks the language of the view', async () => {
    api(() => json({}, 404));
    const pt = dictionary('pt');
    const host = await goal('pt');
    expect(find(host, 'h2').textContent).toBe(pt.embed.title);
    expect(find(shell(host), '[data-ui="disclaimer"] p').textContent).toBe(DISCLAIMER.pt);
  });
});

describe('the embed’s vault', () => {
  const answer = (provenance: 'sandbox' | 'live' = 'sandbox') => {
    const c = chainOf([vault({ provenance })], { provenance });
    return {
      chain: 'solana',
      name: 'Solana',
      mode: 'live',
      provenance,
      vault: c.vaults[0],
      prices: [
        price('solana:usdy', '1.1', { provenance }),
        price('solana:paxg', '2600', { provenance }),
      ],
      disclaimer: 'x',
    };
  };
  const shown = async (respond: (url: string) => Response) => {
    api(respond);
    const host = await mount(
      inLanguage(
        'en',
        createElement(EmbedVault, {
          chain: 'solana',
          address: VAULT,
          style: themeStyle(SAMPLE),
        }),
      ),
    );
    await settle();
    return host;
  };

  it('reads the public route only, and shows the value and each part on a pin, MOCK where not live', async () => {
    const host = await shown(() => json(answer()));
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([`/v1/vaults/solana/${VAULT}`]);
    expect(find(host, 'h2').textContent).toBe(en.embed.vault.title('Solana'));
    const pins = [...host.querySelectorAll('[data-ui="figure"]')];
    expect(pins).toHaveLength(3);
    expect(pins.map((p) => p.getAttribute('data-state'))).toEqual(['mock', 'mock', 'mock']);
    expect(host.querySelector('[data-ui="mock-plate"]')).not.toBeNull();
    expect(host.textContent).toContain(en.shell.testNetwork);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
    // the way out, and the credit, both to the public vault page, in a new tab
    const out = [...host.querySelectorAll(`a[href="/vaults/solana/${VAULT}"]`)];
    expect(out.map((a) => a.getAttribute('target'))).toEqual(['_blank', '_blank']);
    expect(out[0]?.textContent).toBe(en.embed.vault.see);
    expect(find(host, '[data-ui="disclaimer"] p').textContent).toBe(DISCLAIMER.en);
  });

  it('draws a live vault with live pins and no plate', async () => {
    const host = await shown(() => json(answer('live')));
    expect(host.querySelector('[data-ui="mock-plate"]')).toBeNull();
    expect(
      [...host.querySelectorAll('[data-ui="figure"]')].map((p) => p.getAttribute('data-state')),
    ).toEqual(['live', 'live', 'live']);
  });

  it('says one sentence and nothing else for a vault that is not there, or an answer for another', async () => {
    for (const respond of [
      () => json({ error: 'no vault at that address' }, 404),
      () => json({ ...answer(), vault: { ...answer().vault, address: SECOND_VAULT } }),
      () => json({ nonsense: true }),
    ]) {
      const host = await shown(respond);
      const section = find(host, '[data-ui="embed-shell"]');
      expect(section.getAttribute('data-state')).toBe('unavailable');
      expect(section.textContent).toBe(en.embed.unavailable);
      await unmountAll();
      vi.restoreAllMocks();
    }
  });
});
