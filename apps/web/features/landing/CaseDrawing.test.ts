// @vitest-environment happy-dom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CaseDrawing } from './CaseDrawing';

// The two places drawn in the hero joint's ink (gate JOINT-3D): its line weights, its colours from the
// page's tokens so the theme swaps them, far lines dashed, and nothing that is not a line or a fill.

const draw = (place: 'coast' | 'ridge') => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(createElement(CaseDrawing, { place, label: place }));
  return host.querySelector('svg') as SVGSVGElement;
};

describe('the case drawings', () => {
  for (const place of ['coast', 'ridge'] as const) {
    it(`draws the ${place} in the hero's weights, at any size, in the page's own colours`, () => {
      const svg = draw(place);
      const strokes = [...svg.querySelectorAll('[stroke-width]')].map((p) =>
        Number(p.getAttribute('stroke-width')),
      );
      expect(new Set(strokes)).toEqual(new Set([1.5, 0.85, 1.25]));
      for (const p of svg.querySelectorAll('path[stroke="currentColor"]'))
        expect(p.getAttribute('vector-effect')).toBe('non-scaling-stroke');
      // colours only by token: no literal colour anywhere in the drawing
      expect(svg.outerHTML).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(|hsl\(/i);
      // the far is dashed, and so is the route or the goal; the rest is solid
      expect(svg.querySelectorAll('[data-part="far"][stroke-dasharray]').length).toBeGreaterThan(0);
      // covers its slot as the photograph did, and is named for a reader
      expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid slice');
      expect(svg.getAttribute('role')).toBe('img');
      expect(svg.querySelector('title')?.textContent).toBe(place);
      expect(svg.querySelector('image, foreignObject, text')).toBeNull();
    });
  }

  it('gives each ridge its own clip, so two on one page cannot share one', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      createElement('div', null, [
        createElement(CaseDrawing, { key: 1, place: 'ridge', label: 'a' }),
        createElement(CaseDrawing, { key: 2, place: 'ridge', label: 'b' }),
      ]),
    );
    const ids = [...host.querySelectorAll('clipPath')].map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
  });
});
