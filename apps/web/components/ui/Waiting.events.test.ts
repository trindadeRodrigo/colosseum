// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dictionary } from '../../i18n';
import { SkeletonStats } from './Skeleton';
import { GLOBALS } from './test/css';
import { click, find, mount, unmountAll } from './test/dom';
import { Waiting } from './Waiting';
import { GIVE_UP_AFTER_MS, LOADER_AFTER_MS, SLOW_AFTER_MS } from './wait';

// A wait for data: busy with its skeleton from the start, its words after 400ms, one calm line after
// 4 seconds (the hosted API may be waking), and after a minute the failure and a retry that waits
// again. The loader holds still under reduced motion.

const words = {
  slow: 'Still loading. The server may be waking up.',
  over: 'Nothing came.',
  retry: 'Try again',
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

const later = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('Waiting', () => {
  it('is busy with the skeleton from the start, and says what it waits for only after 400ms', async () => {
    const host = await mount(
      createElement(Waiting, {
        label: 'Reading the pools…',
        words,
        skeleton: createElement(SkeletonStats, { count: 3 }),
      }),
    );
    const region = find(host, '[data-ui="waiting"]');
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelectorAll('[data-ui="skeleton-stats"] [data-ui="skeleton"]').length).toBe(6);
    // the skeleton is hidden from a screen reader; the one status line is what is announced
    expect(find(host, '[data-ui="skeleton-stats"]').getAttribute('aria-hidden')).toBe('true');
    const status = find(host, '[role="status"]');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(status.textContent).toBe('');
    await later(LOADER_AFTER_MS);
    expect(status.textContent).toBe('Reading the pools…');
    expect(find(host, '[data-ui="lattice-loader"]').classList).toContain('tf-lattice-assemble');
  });

  it('adds one calm line after 4 seconds, in the same status line', async () => {
    const host = await mount(createElement(Waiting, { label: 'Reading the vault…', words }));
    await later(SLOW_AFTER_MS - 1);
    expect(host.querySelector('[data-ui="waiting-slow"]')).toBeNull();
    await later(1);
    expect(find(host, '[role="status"] [data-ui="waiting-slow"]').textContent).toBe(words.slow);
    expect(find(host, '[data-ui="waiting"]').getAttribute('data-phase')).toBe('slow');
  });

  it('gives up after a minute with the failure and a retry, which waits again', async () => {
    const onRetry = vi.fn();
    const host = await mount(createElement(Waiting, { label: 'Reading…', words, onRetry }));
    await later(GIVE_UP_AFTER_MS);
    const over = find(host, '[data-ui="waiting"]');
    expect(over.getAttribute('data-phase')).toBe('over');
    expect(over.getAttribute('aria-busy')).toBeNull();
    expect(find(host, '[role="alert"]').textContent).toBe(words.over);
    await click(find(host, 'button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    // a new wait: busy again, the clock started over
    expect(find(host, '[data-ui="waiting"]').getAttribute('aria-busy')).toBe('true');
    await later(SLOW_AFTER_MS);
    expect(find(host, '[data-ui="waiting"]').getAttribute('data-phase')).toBe('slow');
  });

  it('floats its line over a tall skeleton: the region is exactly its skeleton, said once', async () => {
    const host = await mount(
      createElement(Waiting, {
        float: true,
        label: 'Reading your plans…',
        words,
        skeleton: createElement(SkeletonStats, { count: 3 }),
      }),
    );
    const region = find(host, '[data-ui="waiting"]');
    expect(region.getAttribute('aria-busy')).toBe('true');
    // the skeleton is the region's one child in the flow; the line's holder has no height
    const [skeleton, holder] = [...region.children] as HTMLElement[];
    expect(skeleton?.getAttribute('data-ui')).toBe('skeleton-stats');
    expect(holder?.classList).toContain('h-0');
    expect(holder?.classList).toContain('sticky');
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    const status = find(host, '[role="status"]');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');
    await later(LOADER_AFTER_MS);
    expect(status.textContent).toBe('Reading your plans…');
    // a few seconds in, one honest line; never a bar that pretends to know how far along it is
    await later(SLOW_AFTER_MS - LOADER_AFTER_MS);
    expect(find(host, '[role="status"] [data-ui="waiting-slow"]').textContent).toBe(words.slow);
    expect(host.querySelectorAll('[role="progressbar"], progress')).toHaveLength(0);
    await later(GIVE_UP_AFTER_MS - SLOW_AFTER_MS);
    // a wait does not run for ever: the skeleton gives way to the failure and a retry
    expect(host.querySelector('[data-ui="skeleton"]')).toBeNull();
    expect(find(host, '[role="alert"]').textContent).toBe(words.over);
    expect(find(host, 'button').textContent).toBe(words.retry);
  });

  it('the app’s own line for a long wait is honest about what it knows', () => {
    for (const lang of ['en', 'pt'] as const) {
      const said = dictionary(lang).shell.wait;
      // what may be happening, never how long is left
      expect(said.slow).not.toMatch(/\d|%/);
      expect(said.over).not.toMatch(/\d|%/);
    }
    expect(dictionary('en').shell.wait.slow).toBe('Still loading. The server may be waking up.');
  });

  it('holds the loader still under reduced motion, and moves nothing else', () => {
    const css = readFileSync(GLOBALS, 'utf8');
    const reduced = css.slice(
      css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .tf-lattice'),
    );
    expect(reduced).toMatch(
      /\.tf-lattice-assemble \.tf-lattice-h,\s*\.tf-lattice-assemble \.tf-lattice-v \{\s*animation: none;/,
    );
    // the boxes themselves never animate: no pulse, no shimmer (button.md, card.md)
    expect(css).not.toMatch(/skeleton[^{]*\{[^}]*animation/);
  });
});
