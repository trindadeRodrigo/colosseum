// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkeletonStats } from './Skeleton';
import { GLOBALS } from './test/css';
import { click, find, mount, unmountAll } from './test/dom';
import { Waiting } from './Waiting';
import { GIVE_UP_AFTER_MS, LOADER_AFTER_MS, SLOW_AFTER_MS } from './wait';

// A wait for data: busy with its skeleton from the start, its words after 400ms, one calm line after
// 4 seconds (the hosted API may be waking), and after a minute the failure and a retry that waits
// again. The loader holds still under reduced motion.

const words = { slow: 'Waking the data service.', over: 'Nothing came.', retry: 'Try again' };

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
