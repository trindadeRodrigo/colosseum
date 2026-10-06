// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DISCLAIMER } from '@colosseum/schemas';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, press, settle, type, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary, type Lang } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { GOAL_HANDOFF } from '../goal/draft';
import { router } from '../wallet/test/mock-next';
import { sceneModule } from './JointStage';
import { Landing } from './Landing';

const scene = vi.hoisted(() => ({
  create: vi.fn((_canvas: HTMLCanvasElement, _options?: { onReady?: () => void }) => ({
    setProgress: vi.fn(),
    resize: vi.fn(),
    setVisible: vi.fn(),
    dispose: vi.fn(),
  })),
}));
vi.mock('./joint-scene', () => ({ createJointScene: scene.create }));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// His landing page (hero-3d.html) with real events: the hero and its three steps, the 3D joint only
// where it can and may run, the two sample cases always MOCK, the typing box that hands a goal to the
// product, and an email field that sends nothing and says so.

const en = dictionary('en');
const landing = async (lang: Lang = 'en', signedIn = false) => {
  const host = await mount(
    inLanguage(lang, createElement(Landing, { lang, theme: 'auto', signedIn })),
  );
  await settle(10);
  return host;
};

/** The probe's WebGL context, let go once the stage knows WebGL is there. */
const released = vi.fn();

/** What the browser says about reduced motion, WebGL, its renderer and saving data, for one test. */
function browser({ reduce = false, webgl = false, saveData = false, gpu = 'Apple M1' } = {}) {
  Object.defineProperty(navigator, 'connection', { value: { saveData }, configurable: true });
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query.includes('reduce'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      (webgl
        ? ({
            getExtension: () => ({ loseContext: released, UNMASKED_RENDERER_WEBGL: 0x9246 }),
            getParameter: () => gpu,
          } as unknown as RenderingContext)
        : null) as never,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  router.push.mockClear();
  scene.create.mockClear();
});
afterEach(async () => {
  await unmountAll();
  vi.restoreAllMocks();
});

describe('the hero', () => {
  it('is his line, his tagline and the three steps, each one in the page for anyone to read', async () => {
    browser();
    const host = await landing();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(find(host, 'h1').textContent).toBe(en.landing.stage.title);
    const steps = ['step-1', 'step-2', 'step-3'].map((id) => find(host, `#${id}`));
    expect(steps.map((s) => s.querySelector('h2')?.textContent)).toEqual(
      en.landing.stage.steps.map((s) => s.title),
    );
    // the stage is named, and what is drawn is not read out
    expect(find(host, '#stage').getAttribute('aria-label')).toBe(en.landing.stage.label);
    expect(find(host, 'canvas').closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('offers Products, Invest and Analytics in its bar, and no Resources (Thom, Oct 6)', async () => {
    browser();
    const host = await landing();
    const bar = find(host, '[data-ui="compact-nav"]');
    expect([...bar.querySelectorAll('nav a')].map((a) => a.getAttribute('href'))).toEqual([
      '#showcase',
      '#simulate',
      '/analytics/stocks',
      // and the one action
      '/sign-in?next=/goal',
    ]);
    expect(bar.textContent).not.toContain(en.landing.nav.resources);
  });

  it('loads the 3D joint where WebGL runs and motion is allowed, and drives it by scrolling', async () => {
    browser({ webgl: true });
    const host = await landing();
    expect(scene.create).toHaveBeenCalledTimes(1);
    expect(scene.create).toHaveBeenCalledWith(
      find(host, 'canvas'),
      expect.objectContaining({ onReady: expect.any(Function), light: expect.any(Boolean) }),
    );
    // the context that only asked whether WebGL is there is let go
    expect(released).toHaveBeenCalled();
    const made = scene.create.mock.results[0]?.value as { setProgress: ReturnType<typeof vi.fn> };
    expect(made.setProgress).toHaveBeenCalled();
    // nothing stands in while it loads, and the canvas shows once its first frame is drawn
    expect(host.querySelector('.sticky [data-ui="joint-still"]')).toBeNull();
    expect(find(host, 'canvas').className).toContain('opacity-0');
    await act(async () => scene.create.mock.calls[0]?.[1]?.onReady?.());
    expect(find(host, 'canvas').className).toContain('opacity-100');
  });

  it('draws no 3D at all with reduced motion: the still, seated, beside the copy', async () => {
    browser({ webgl: true, reduce: true });
    const host = await landing();
    expect(scene.create).not.toHaveBeenCalled();
    const still = [...host.querySelectorAll('[data-ui="joint-still"]')].find(
      (d) => d.getAttribute('aria-hidden') !== 'true',
    );
    expect(still?.getAttribute('data-seated')).toBe('true');
    const frames = [...(still?.querySelectorAll('img') ?? [])];
    expect(frames.map((img) => img.getAttribute('src'))).toEqual([
      '/landing/joint/joint-seated-dark.svg',
      '/landing/joint/joint-seated-light.svg',
    ]);
    // each frame says what the joint does; the theme shows one of them, so one is read
    for (const img of frames) expect(img.getAttribute('alt')).toBe(en.landing.stage.drawing);
    for (const img of frames) expect(img.getAttribute('loading')).toBe('lazy');
    // and the nav does not wait for the stage: it is compact at once
    await settle(10);
    expect(find(host, '[data-ui="compact-nav"]').getAttribute('data-compact')).toBe('true');
  });

  it('shows the stills of the same joint, and loads no scene, where there is no WebGL', async () => {
    browser({ webgl: false });
    const host = await landing();
    expect(scene.create).not.toHaveBeenCalled();
    const stills = [...host.querySelectorAll('.sticky [data-ui="joint-still"]')];
    expect(stills.map((s) => s.getAttribute('data-seated'))).toEqual(['false', 'true']);
  });

  it('shows the stills, and loads no scene, where WebGL is only a software rasteriser', async () => {
    browser({
      webgl: true,
      gpu: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)',
    });
    const host = await landing();
    expect(scene.create).not.toHaveBeenCalled();
    expect(host.querySelectorAll('.sticky [data-ui="joint-still"]')).toHaveLength(2);
  });

  it('falls back to the stills when the scene’s module does not come (an old page after a deploy)', async () => {
    browser({ webgl: true });
    const load = vi.spyOn(sceneModule, 'load').mockRejectedValueOnce(new Error('chunk failed'));
    const host = await landing();
    expect(load).toHaveBeenCalled();
    expect(scene.create).not.toHaveBeenCalled();
    expect(host.querySelectorAll('.sticky [data-ui="joint-still"]')).toHaveLength(2);
  });

  it('falls back to the stills when the scene cannot start', async () => {
    browser({ webgl: true });
    scene.create.mockImplementationOnce(() => {
      throw new Error('no context');
    });
    const host = await landing();
    expect(host.querySelectorAll('.sticky [data-ui="joint-still"]')).toHaveLength(2);
  });

  it('loads no scene when the visitor saves data: the same drawing stands in as stills', async () => {
    browser({ webgl: true, saveData: true });
    const host = await landing();
    expect(scene.create).not.toHaveBeenCalled();
    const stills = [...host.querySelectorAll('.sticky [data-ui="joint-still"]')];
    expect(stills.map((s) => s.getAttribute('data-seated'))).toEqual(['false', 'true']);
    // only the frame the theme shows is fetched, and only when it is shown
    for (const img of host.querySelectorAll('.sticky img'))
      expect(img.getAttribute('loading')).toBe('lazy');
  });
});
describe('the hero on a phone (hero-3d.html, its 820px rule)', () => {
  /** A copy block placed by a test: its middle at `share` of an 844px screen. */
  const place = (el: Element, share: number) => {
    const mid = 844 * share;
    el.getBoundingClientRect = () =>
      ({
        top: mid - 100,
        bottom: mid + 100,
        height: 200,
        width: 390,
        left: 0,
        right: 390,
      }) as DOMRect;
  };
  const scrollNow = async () => {
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
      await new Promise((done) => requestAnimationFrame(() => done(null)));
    });
  };

  it('keeps the copy at the foot, and fades a line before it can rise into the joint', async () => {
    browser();
    const width = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const height = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    try {
      const host = await landing();
      const hero = find(host, '#stage [data-low]');
      // the copy sits at the foot of the screen on a phone, as his prototype has it
      expect(hero.parentElement?.parentElement?.className).toContain('max-[819px]:items-end');
      const step = find(host, '#step-1 [data-on]');
      // low on the screen: shown
      place(hero, 0.75);
      place(step, 0.7);
      await scrollNow();
      expect(hero.getAttribute('data-low')).toBe('true');
      expect(hero.className).not.toContain('max-[819px]:opacity-0');
      expect(step.getAttribute('data-on')).toBe('true');
      expect(step.className).not.toContain('max-[819px]:opacity-0');
      // risen toward the joint, which takes the top third: faded before its plate gets there
      place(hero, 0.3);
      place(step, 0.3);
      await scrollNow();
      expect(hero.getAttribute('data-low')).toBe('false');
      expect(hero.className).toContain('max-[819px]:opacity-0');
      expect(step.getAttribute('data-on')).toBe('false');
      expect(step.className).toContain('max-[819px]:opacity-0');
      // with reduced motion nothing is pinned, and nothing fades
      expect(step.className).toContain('motion-reduce:opacity-100');
      // the copy marks itself for the bar, which takes its ground when copy reaches it
      expect(hero.hasAttribute('data-under-bar')).toBe(true);
      expect(step.hasAttribute('data-under-bar')).toBe(true);
    } finally {
      if (width) Object.defineProperty(window, 'innerWidth', width);
      if (height) Object.defineProperty(window, 'innerHeight', height);
    }
  });

  it('fades nothing on a wide screen: the copy stands beside the joint there', async () => {
    browser();
    const host = await landing();
    const step = find(host, '#step-1 [data-on]');
    place(step, 0.3);
    await scrollNow();
    // on a wide screen a step is read from 15% of the way down
    expect(step.getAttribute('data-on')).toBe('true');
  });
});

describe('the showcase', () => {
  it('shows his two sample people, each case MOCK in its head and on every pinned figure', async () => {
    browser();
    const host = await landing();
    const cases = [...host.querySelectorAll('article[data-ui="showcase-case"]')];
    expect(cases.map((c) => c.getAttribute('aria-label'))).toEqual([
      en.landing.show.trip.label,
      en.landing.show.growth.label,
    ]);
    for (const c of cases) {
      // the plate in the case's head, not only the pins' own
      expect(
        c.querySelector('[data-ui="case-head"] [data-ui="mock-plate"]')?.textContent,
      ).toContain('MOCK');
      const pins = [...c.querySelectorAll('[data-ui="figure"]')];
      expect(pins.length).toBeGreaterThan(0);
      // nothing in a sample case is drawn as live
      expect(pins.map((p) => p.getAttribute('data-state'))).toEqual(pins.map(() => 'mock'));
      expect(c.querySelector('[role="img"]')?.getAttribute('aria-label')).toBeTruthy();
      expect(c.querySelector('blockquote')?.textContent).toMatch(/^“.+”$/);
    }
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('draws each plan as a joint whose parts are its legend’s, share for share', async () => {
    browser();
    const host = await landing();
    const cases = [...host.querySelectorAll('article[data-ui="showcase-case"]')];
    expect(cases).toHaveLength(2);
    for (const c of cases) {
      const drawing = c.querySelector('svg[data-ui="plan-drawing"]');
      const drawn = [...(drawing?.querySelectorAll('[data-part="layer"]') ?? [])].map((l) =>
        Number(l.getAttribute('data-share')),
      );
      const legend = [...c.querySelectorAll(`ul[aria-label="${en.landing.show.legs}"] li`)].map(
        (li) => Number(li.querySelector('.font-mono')?.textContent?.replace('%', '')),
      );
      expect(drawn.length).toBeGreaterThan(0);
      expect(drawn).toEqual(legend);
      // no photograph, and no caption saying one was there
      expect(c.querySelector('img, figcaption')).toBeNull();
    }
    expect(host.textContent).not.toContain('placeholder photo');
  });

  it('puts the person and their words above the drawing of their plan, in every case', async () => {
    browser();
    const host = await landing();
    for (const c of host.querySelectorAll('article[data-ui="showcase-case"]')) {
      const quote = find(c as HTMLElement, 'blockquote');
      const drawing = find(c as HTMLElement, 'svg[data-ui="plan-drawing"]');
      // the quote comes first in the page, so it is read and laid out first at every width
      expect(
        quote.compareDocumentPosition(drawing) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(quote.parentElement?.nextElementSibling).toBe(drawing);
    }
  });

  it('lights a part on the drawing and in the list together, from either side', async () => {
    browser();
    const host = await landing();
    const growth = [
      ...host.querySelectorAll<HTMLElement>('article[data-ui="showcase-case"]'),
    ][1] as HTMLElement;
    const layer = (n: number) => find(growth, `[data-part="layer"][data-chart="${n}"]`);
    const row = (n: number) => find(growth, `[data-ui="case-leg"][data-chart="${n}"]`);
    const mouse = (type: string, el: Element) =>
      act(async () => {
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerType: 'mouse',
            relatedTarget: document.body,
          }),
        );
      });
    // the stocks layer, 45%: named for a reader, lit, the others dimmed, and its row lit
    expect(layer(3).getAttribute('aria-label')).toBe('Tokenized stocks (SPYx, QQQx), 45%');
    await mouse('pointerover', layer(3));
    expect(layer(3).getAttribute('data-lit')).toBe('true');
    expect(layer(3).getAttribute('aria-pressed')).toBe('true');
    expect(layer(1).getAttribute('class')).toContain('opacity-35');
    expect(row(3).getAttribute('data-lit')).toBe('true');
    expect(row(1).getAttribute('class')).toContain('opacity-45');
    await mouse('pointerout', layer(3));
    expect(row(3).getAttribute('data-lit')).toBe('false');
    // and back: a row lights its layer
    await mouse('pointerover', row(2));
    expect(layer(2).getAttribute('data-lit')).toBe('true');
    await mouse('pointerout', row(2));
    expect(layer(2).getAttribute('data-lit')).toBe('false');
  });

  it('lights the trip’s bars for the part lit on its drawing', async () => {
    browser();
    const host = await landing();
    const trip = host.querySelector('article[data-ui="showcase-case"]') as HTMLElement;
    await act(async () => {
      find(trip, '[data-part="layer"][data-chart="2"]').dispatchEvent(
        new PointerEvent('pointerover', {
          bubbles: true,
          pointerType: 'mouse',
          relatedTarget: document.body,
        }),
      );
    });
    const opacity = (n: number) =>
      new Set(
        [...trip.querySelectorAll(`rect[data-series="part-${n}"]`)].map((r) =>
          r.getAttribute('opacity'),
        ),
      );
    expect(opacity(2)).toEqual(new Set(['1']));
    expect(opacity(1)).toEqual(new Set(['0.25']));
  });

  it('is one tab stop the arrows step through, layer by layer; Escape lets go', async () => {
    browser();
    const host = await landing();
    const growth = [
      ...host.querySelectorAll<HTMLElement>('article[data-ui="showcase-case"]'),
    ][1] as HTMLElement;
    const layers = [...growth.querySelectorAll<HTMLElement>('[data-part="layer"]')];
    expect(layers.map((l) => l.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
    await act(async () => layers[0]?.focus());
    expect(layers[0]?.getAttribute('data-lit')).toBe('true');
    expect(find(growth, '[data-ui="case-leg"][data-chart="1"]').getAttribute('data-lit')).toBe(
      'true',
    );
    await press(layers[0] as HTMLElement, 'ArrowUp');
    expect(document.activeElement).toBe(layers[1]);
    expect(layers[1]?.getAttribute('data-lit')).toBe('true');
    expect(layers.map((l) => l.getAttribute('tabindex'))).toEqual(['-1', '0', '-1', '-1']);
    await press(layers[1] as HTMLElement, 'End');
    expect(document.activeElement).toBe(layers[3]);
    await press(layers[3] as HTMLElement, 'Escape');
    expect(layers.map((l) => l.getAttribute('data-lit'))).toEqual([
      'false',
      'false',
      'false',
      'false',
    ]);
  });

  it('picks a part with a tap and lets it go with a tap outside', async () => {
    browser();
    const host = await landing();
    const growth = [
      ...host.querySelectorAll<HTMLElement>('article[data-ui="showcase-case"]'),
    ][1] as HTMLElement;
    const layer = find(growth, '[data-part="layer"][data-chart="4"]');
    await act(async () => {
      layer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
    });
    expect(layer.getAttribute('data-lit')).toBe('true');
    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }),
      );
    });
    expect(layer.getAttribute('data-lit')).toBe('false');
  });

  it('lifts a lit layer only where motion is welcome; with reduced motion only its colour changes', async () => {
    browser({ reduce: true });
    const host = await landing();
    const layer = host.querySelector('[data-part="layer"][data-chart="1"]') as HTMLElement;
    await act(async () => layer.focus());
    const cls = layer.getAttribute('class') ?? '';
    expect(cls).toContain('-translate-y-1.5');
    expect(cls).toContain('motion-reduce:translate-y-0');
    expect(cls).toContain('motion-safe:transition-[translate,opacity]');
    for (const svg of host.querySelectorAll('svg[data-ui="plan-drawing"]'))
      expect(svg.getAttribute('data-state')).toBe('still');
  });

  it('keeps a figure’s date in one piece: "Dec 2031" never breaks across lines', async () => {
    browser();
    const host = await landing();
    const growth = [
      ...host.querySelectorAll<HTMLElement>('article[data-ui="showcase-case"]'),
    ][1] as HTMLElement;
    const units = [...growth.querySelectorAll('dd small')];
    const date = units.find((u) => u.textContent === 'Dec 2031');
    expect(date?.getAttribute('class')).toContain('whitespace-nowrap');
  });

  it('settles the joint in from the bottom when the card comes into view, and not with reduced motion', async () => {
    const seen: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          seen.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 5000,
    } as DOMRect);
    browser();
    let host = await landing();
    const drawings = () => [...host.querySelectorAll('svg[data-ui="plan-drawing"]')];
    expect(drawings().map((d) => d.getAttribute('data-state'))).toEqual(['armed', 'armed']);
    await act(async () => {
      for (const cb of seen) cb([{ isIntersecting: true }]);
    });
    expect(drawings().map((d) => d.getAttribute('data-state'))).toEqual(['in', 'in']);
    await unmountAll();
    vi.restoreAllMocks();
    // with reduced motion it stands as it is, and nothing waits for it
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 5000,
    } as DOMRect);
    browser({ reduce: true });
    host = await landing();
    expect(drawings().map((d) => d.getAttribute('data-state'))).toEqual(['still', 'still']);
    await unmountAll();
    vi.restoreAllMocks();
    // already on screen when the page opens: it stands as it is, nothing hidden to come in
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 120 } as DOMRect);
    browser();
    host = await landing();
    expect(drawings().map((d) => d.getAttribute('data-state'))).toEqual(['still', 'still']);
    vi.unstubAllGlobals();
  });

  it('keeps stock tokens out of the income case (PROTECT-NO-STOCKS) and names them in the growth case', async () => {
    browser();
    const host = await landing();
    const [trip, growth] = [...host.querySelectorAll('article[data-ui="showcase-case"]')];
    const parts = (c: Element | undefined) =>
      c?.querySelector(`ul[aria-label="${en.landing.show.legs}"]`)?.textContent ?? '';
    expect(parts(trip)).not.toMatch(/stock/i);
    expect(parts(growth)).toMatch(/Tokenized stocks/);
  });

  it('puts the disclaimer, whole, once under the section', async () => {
    browser();
    const host = await landing();
    const blocks = [...host.querySelectorAll('[data-ui="disclaimer"]')];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.textContent).toBe(DISCLAIMER.en);
    expect(blocks[0]?.closest('#showcase')).not.toBeNull();
  });
});

describe('the typing box', () => {
  it('hands the goal to the product to be read there, and reads nothing itself', async () => {
    browser();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const host = await landing();
    const box = find<HTMLTextAreaElement>(host, '#simulate textarea');
    await type(box, 'Grow $2,000 for ten years');
    await press(box, 'Enter');
    expect(window.sessionStorage.getItem(GOAL_HANDOFF)).toBe('Grow $2,000 for ten years');
    expect(router.push).toHaveBeenCalledWith('/goal');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fills the box from an example and sends nothing', async () => {
    browser();
    const host = await landing();
    const example = en.landing.sim.examples[0] as string;
    await click(
      [...host.querySelectorAll('#simulate button')].find(
        (b) => b.textContent === example,
      ) as HTMLElement,
    );
    expect(find<HTMLTextAreaElement>(host, '#simulate textarea').value).toBe(example);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('says how to send under the chips, and leads a visitor to sign in for the goal', async () => {
    browser();
    const host = await landing();
    const sim = find(host, '#simulate');
    const hint = [...sim.querySelectorAll('p')].find(
      (p) => p.textContent === en.goal.composer.hint,
    ) as HTMLElement;
    expect(find(sim, 'textarea').getAttribute('aria-describedby')?.split(' ')).toContain(hint.id);
    const link = [...sim.querySelectorAll('a')].find((a) => a.textContent === en.goal.visitor.link);
    expect(link?.getAttribute('href')).toBe('/sign-in?next=/goal');
  });
});

describe('the closing', () => {
  it('sends no address anywhere, and says so before and after', async () => {
    browser();
    const fetch = vi.spyOn(globalThis, 'fetch');
    const host = await landing();
    const closing = find(host, '#updates');
    expect(closing.textContent).toContain(en.landing.closing.status.rest);
    await type(find<HTMLInputElement>(closing, 'input[type="email"]'), 'me@example.com');
    await click(closing.querySelector('input[type="checkbox"]') as HTMLElement);
    await act(async () => {
      find<HTMLFormElement>(closing, 'form').requestSubmit();
    });
    expect(closing.textContent).toContain(en.landing.closing.status.success);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says what is wrong with an address before anything else', async () => {
    browser();
    const host = await landing();
    const closing = find(host, '#updates');
    await type(find<HTMLInputElement>(closing, 'input[type="email"]'), 'me@');
    await act(async () => {
      find<HTMLFormElement>(closing, 'form').requestSubmit();
    });
    expect(closing.textContent).toContain(en.landing.closing.status['invalid-email']);
  });

  it('shows the joint drawn in ink, coming together, and no photograph (CLOSING-INK)', async () => {
    browser();
    const host = await landing();
    const closing = find(host, '#updates');
    expect(closing.querySelector('img, figure, figcaption')).toBeNull();
    const drawing = find(closing, 'svg[data-ui="closing-drawing"]');
    expect(drawing.getAttribute('role')).toBe('img');
    expect(drawing.getAttribute('aria-label')).toBe(en.landing.closing.drawingAlt);
    // the three pieces, the guides that show how they meet, and nothing raster
    for (const part of ['rail', 'post', 'nose', 'pin', 'guides'])
      expect(drawing.querySelector(`[data-part="${part}"]`), part).not.toBeNull();
    expect(drawing.querySelector('image, foreignObject')).toBeNull();
    // happy-dom has no IntersectionObserver: the drawing stays exploded, the guides shown
    expect(drawing.getAttribute('data-state')).toBe('apart');
  });

  it('stands assembled and still with reduced motion, by CSS before any script', async () => {
    browser({ reduce: true });
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const host = await landing();
    const drawing = find(host, 'svg[data-ui="closing-drawing"]');
    expect(drawing.getAttribute('data-state')).toBe('still');
    for (const part of ['rail', 'nose', 'pin']) {
      const cls = find(drawing, `[data-part="${part}"]`).getAttribute('class') ?? '';
      expect(cls, part).toContain('motion-reduce:!translate-none');
      expect(cls, part).toContain('motion-reduce:transition-none');
    }
    expect(find(drawing, '[data-part="guides"]').getAttribute('class')).toContain(
      'motion-reduce:opacity-0',
    );
    vi.unstubAllGlobals();
  });

  it('closes together once when it comes into view, where motion is welcome', async () => {
    const seen: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          seen.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    browser();
    const host = await landing();
    const drawing = find(host, 'svg[data-ui="closing-drawing"]');
    const rail = () =>
      (find(drawing, '[data-part="rail"]') as unknown as SVGElement).style.translate;
    expect(drawing.getAttribute('data-state')).toBe('apart');
    expect(rail()).not.toBe('');
    await act(async () => {
      for (const cb of seen) cb([{ isIntersecting: true }]);
    });
    expect(drawing.getAttribute('data-state')).toBe('in');
    expect(rail()).toBe('');
    vi.unstubAllGlobals();
  });
});

it('ships no closing photograph: nothing in the app names closing.jpg, and the file is gone', () => {
  const web = join(import.meta.dirname, '..', '..');
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (
        /\.(tsx?|mjs|css|json)$/.test(name) &&
        readFileSync(path, 'utf8').includes('closing.jpg')
      )
        found.push(path.slice(web.length + 1));
    }
  };
  for (const top of ['app', 'components', 'features', 'i18n', 'e2e']) walk(join(web, top));
  expect(found.filter((f) => !f.endsWith('landing.events.test.ts'))).toEqual([]);
  expect(existsSync(join(web, 'public', 'landing', 'closing.jpg'))).toBe(false);
});

it('says the whole page in Portuguese, and calls its figures MOCK in the foot', async () => {
  browser();
  const pt = dictionary('pt');
  const host = await landing('pt');
  expect(find(host, 'h1').textContent).toBe(pt.landing.stage.title);
  expect(host.textContent).toContain(pt.landing.show.title);
  expect(host.textContent).toContain(pt.landing.sim.title);
  expect(find(host, 'footer').textContent).toContain(pt.landing.foot);
  expect(host.textContent).not.toContain(en.landing.show.title);
});

it('keeps “System” as a choice on the landing, so the next visit follows the system too', async () => {
  browser();
  const host = await landing();
  const system = [...find(host, '[data-ui="theme-switch"]').querySelectorAll('button')][0];
  await click(system as HTMLElement);
  expect(document.cookie).toContain('tf-theme=auto');
});

describe('the bar’s action', () => {
  const action = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLAnchorElement>('[data-ui="compact-nav"] a')].filter((a) =>
      [
        en.landing.nav.cta,
        en.landing.nav.openApp,
        pt.landing.nav.cta,
        pt.landing.nav.openApp,
      ].includes(a.textContent ?? ''),
    );
  const pt = dictionary('pt');

  it('is "Sign in" for a visitor, and the visitor line asks them to sign in', async () => {
    browser();
    const host = await landing();
    expect(action(host).map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      [en.landing.nav.cta, '/sign-in?next=/goal'],
    ]);
    expect(host.textContent).toContain(en.goal.visitor.link);
  });

  it.each(['en', 'pt'] as const)(
    'leads a person signed in back into the app, in the same style, and asks nothing of them (%s)',
    async (lang) => {
      browser();
      const words = dictionary(lang);
      const host = await landing(lang, true);
      const [open] = action(host);
      expect(action(host)).toHaveLength(1);
      expect(open?.textContent).toBe(words.landing.nav.openApp);
      expect(open?.getAttribute('href')).toBe('/goal');
      expect(host.querySelector('a[href^="/sign-in"]')).toBeNull();
      expect(host.textContent).not.toContain(words.landing.nav.cta);
      expect(host.textContent).not.toContain(words.goal.visitor.link);
      // the filled style of "Sign in"
      await unmountAll();
      const visitor = await landing(lang);
      expect(open?.className).toBe(action(visitor)[0]?.className);
    },
  );
});
