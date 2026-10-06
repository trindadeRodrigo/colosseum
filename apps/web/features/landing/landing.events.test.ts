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
