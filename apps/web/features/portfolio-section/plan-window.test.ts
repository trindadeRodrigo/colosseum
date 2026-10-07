import {
  HISTORY_MAX_POINTS,
  HISTORY_STEP_SECONDS,
  HistoryStep,
  PortfolioHistoryQuery,
} from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { NOW } from './fixtures/answers';
import { DEFAULT_WINDOW, served, stepsOf, WINDOWS, windowOf, windowQuery } from './plan-window';

// How far back a plan's page looks: every choice is a window GET /v1/portfolio/history serves, and a
// window it would refuse (more than HISTORY_MAX_POINTS steps, or a start that is not before its end)
// is never made into a question. The route refuses such a window with 400; it never cuts one.

const now = Date.parse(NOW);

describe('the windows a plan’s page offers', () => {
  it('are four, from a day to ninety days, and the page opens on a week', () => {
    expect(WINDOWS.map((w) => [w.id, w.seconds / 86_400, w.step])).toEqual([
      ['day', 1, '10m'],
      ['week', 7, '1h'],
      ['month', 30, '1h'],
      ['quarter', 90, '1d'],
    ]);
    expect(DEFAULT_WINDOW).toBe('week');
    expect(windowOf('week')?.step).toBe('1h');
    expect(windowOf('decade')).toBeNull();
  });

  it('each span no more steps than the route serves, at a step the route knows', () => {
    for (const window of WINDOWS) {
      expect(HistoryStep.options, window.id).toContain(window.step);
      expect(stepsOf(window), window.id).toBe(window.seconds / HISTORY_STEP_SECONDS[window.step]);
      expect(stepsOf(window), window.id).toBeLessThanOrEqual(HISTORY_MAX_POINTS);
      expect(Number.isInteger(stepsOf(window)), window.id).toBe(true);
      expect(served(window), window.id).toBe(true);
    }
    expect(WINDOWS.map(stepsOf)).toEqual([144, 168, 720, 90]);
  });

  it('are asked with both ends, the span the choice’s own, in a query the contract takes', () => {
    for (const window of WINDOWS) {
      const query = windowQuery(window, now);
      expect(query, window.id).not.toBeNull();
      if (!query) continue;
      expect(PortfolioHistoryQuery.safeParse(query).success, window.id).toBe(true);
      expect(query.to).toBe(NOW);
      expect(query.step).toBe(window.step);
      expect(Date.parse(query.to) - Date.parse(query.from)).toBe(window.seconds * 1000);
    }
    expect(windowQuery(WINDOWS[1], now)).toEqual({
      from: '2026-09-30T12:00:00.000Z',
      to: NOW,
      step: '1h',
    });
  });

  it('keep their span whatever the clock says: a wrong clock moves a window, and never widens it', () => {
    for (const skewed of [now - 400 * 86_400_000, now + 400 * 86_400_000]) {
      for (const window of WINDOWS) {
        const query = windowQuery(window, skewed);
        expect(query).not.toBeNull();
        if (!query) continue;
        const steps =
          (Date.parse(query.to) - Date.parse(query.from)) / 1000 / HISTORY_STEP_SECONDS[query.step];
        expect(steps).toBeLessThanOrEqual(HISTORY_MAX_POINTS);
        expect(Date.parse(query.from)).toBeLessThan(Date.parse(query.to));
      }
    }
  });
});

describe('a window the route would refuse', () => {
  it('is not served, and is never made into a question', () => {
    const refused = [
      // one step more than the route serves
      { seconds: (HISTORY_MAX_POINTS + 1) * 600, step: '10m' },
      { seconds: (HISTORY_MAX_POINTS + 1) * 3600, step: '1h' },
      // ninety days by the ten minutes: 12,960 steps
      { seconds: 90 * 86_400, step: '10m' },
      // a start that is not before its end
      { seconds: 0, step: '1h' },
      { seconds: -3600, step: '1h' },
      { seconds: Number.NaN, step: '1d' },
    ] as const;
    for (const window of refused) {
      expect(served(window), JSON.stringify(window)).toBe(false);
      expect(windowQuery(window, now), JSON.stringify(window)).toBeNull();
    }
    // exactly as many steps as the route serves is still served
    const most = { seconds: HISTORY_MAX_POINTS * 3600, step: '1h' } as const;
    expect(served(most)).toBe(true);
    expect(windowQuery(most, now)?.step).toBe('1h');
  });

  it('is not asked for with a clock that gives no time, or one before the year the route starts at', () => {
    const [day] = WINDOWS;
    expect(windowQuery(day, Number.NaN)).toBeNull();
    expect(windowQuery(day, Number.POSITIVE_INFINITY)).toBeNull();
    expect(windowQuery(day, 1000)).toBeNull();
  });
});
