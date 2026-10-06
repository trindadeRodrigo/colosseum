// @vitest-environment happy-dom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Lang } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { PlanChart } from './PlanChart';
import { planOn } from './test/fixtures';

// The plan's chart leaves room on the left for every value on its axis, in the reader's language:
// "US$ 42.400" is wider than "$42,400", and neither is cut at the edge of the drawing.

const draw = (lang: Lang, amountUsd: number) => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    inLanguage(
      lang,
      createElement(PlanChart, { amountUsd, card: planOn().proposal.card, yieldObs: null }),
    ),
  );
  return host;
};

describe('the plan chart’s value axis', () => {
  for (const lang of ['en', 'pt'] as const)
    for (const amount of [40, 40_000, 2_500_000])
      it(`has room for every label, in ${lang}, for $${amount}`, () => {
        const ticks = [...draw(lang, amount).querySelectorAll('svg text[text-anchor="end"]')];
        expect(ticks.length).toBeGreaterThan(1);
        for (const tick of ticks) {
          const start = Number(tick.getAttribute('x')) - (tick.textContent ?? '').length * 6;
          expect(start, tick.textContent ?? '').toBeGreaterThanOrEqual(0);
        }
      });
});
