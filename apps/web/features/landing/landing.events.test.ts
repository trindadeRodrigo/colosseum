// @vitest-environment happy-dom
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
const landing = async (lang: Lang = 'en') => {
  const host = await mount(inLanguage(lang, createElement(Landing, { lang, theme: 'auto' })));
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
      expect(c.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBeTruthy();
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
