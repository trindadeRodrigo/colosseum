// @vitest-environment happy-dom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { layersOf, PlanDrawing } from './PlanDrawing';
import { GROWTH, TRIP } from './sample';

// The plan drawn as a joint (gate PLAN-JOINT): one layer per part, each as tall as its share, in the
// part's legend colour, tenoned into the one below, in the hero's line weights and the page's tokens.

const parts = (legs: typeof TRIP.legs | typeof GROWTH.legs, names: string[]) =>
  legs.map((leg, i) => ({ leg, name: names[i] ?? '' }));
const draw = (p: ReturnType<typeof parts>) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(createElement(PlanDrawing, { parts: p, label: 'A plan.' }));
  return host.querySelector('svg') as SVGSVGElement;
};

describe('the plan drawn as a joint', () => {
  it('stacks one layer per part, each as tall as its share, the tallest the largest part', () => {
    const layers = layersOf(parts(GROWTH.legs, ['a', 'b', 'c', 'd']));
    const heights = layers.map((l) => l.y1 - l.y0);
    const total = heights.reduce((s, h) => s + h, 0);
    GROWTH.legs.forEach((leg, i) => {
      expect((heights[i] ?? 0) / total).toBeCloseTo(leg.weightBps / 10_000, 6);
    });
    // bottom to top, never overlapping
    for (let i = 1; i < layers.length; i++)
      expect(layers[i]?.y0).toBeGreaterThan(layers[i - 1]?.y1 ?? Infinity);
  });

  it('draws each part in its legend colour, with its share, and says every part to a reader', () => {
    const svg = draw(
      parts(TRIP.legs, ['Cash buffer (USDC)', 'Tokenized treasuries', 'Dollar lending']),
    );
    const layers = [...svg.querySelectorAll('[data-part="layer"]')];
    expect(layers.map((l) => l.getAttribute('data-chart'))).toEqual(['1', '2', '3']);
    expect(layers.map((l) => (l as SVGElement).style.color)).toEqual([
      'var(--chart-1)',
      'var(--chart-2)',
      'var(--chart-3)',
    ]);
    expect(layers.map((l) => l.textContent)).toEqual([
      '15%Cash buffer',
      '55%Tokenized treasuries',
      '30%Dollar lending',
    ]);
    expect(svg.getAttribute('aria-label')).toBe(
      'A plan. Cash buffer (USDC) 15%, Tokenized treasuries 55%, Dollar lending 30%.',
    );
  });

  it('shows every tenon but the foot’s, its length inside the layer above dashed', () => {
    const svg = draw(parts(GROWTH.legs, ['a', 'b', 'c', 'd']));
    const hidden = svg.querySelectorAll('[data-part="hidden"]');
    expect(hidden).toHaveLength(GROWTH.legs.length - 1);
    for (const h of hidden) expect(h.getAttribute('stroke-dasharray')).toBeTruthy();
  });

  it('keeps to the hero’s weights and the page’s tokens', () => {
    const svg = draw(parts(GROWTH.legs, ['a', 'b', 'c', 'd']));
    const widths = new Set(
      [...svg.querySelectorAll('[stroke-width]')].map((p) => p.getAttribute('stroke-width')),
    );
    expect(widths).toEqual(new Set(['1.5', '0.85']));
    expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(|hsl\(/i);
  });

  it('keeps its labels apart, however thin a part is', () => {
    const thin = parts(
      [
        { weightBps: 9400, chart: 1 },
        { weightBps: 200, chart: 2 },
        { weightBps: 200, chart: 3 },
        { weightBps: 200, chart: 4 },
      ],
      ['a', 'b', 'c', 'd'],
    );
    const svg = draw(thin);
    const ys = [...svg.querySelectorAll('[data-part="layer"] text:first-of-type')]
      .map((t) => Number(t.getAttribute('y')))
      .sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++)
      expect((ys[i] ?? 0) - (ys[i - 1] ?? 0)).toBeGreaterThanOrEqual(30);
  });
});
