// @vitest-environment happy-dom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { LIVE_SPECIMEN } from './fixtures/mock';
import { ProvenancePin, QuietPins } from './ProvenancePin';
import { click, find, mount, unmountAll } from './test/dom';

// PIN-QUIET (Rodrigo, Oct 8): in the portfolio and the analytics no glyph sits beside a figure. The
// source is still there: the figure itself is the control that opens it. A sample figure keeps its
// hatched glyph, so nothing made up reads as live.

afterEach(unmountAll);

const quiet = (obs: typeof LIVE_SPECIMEN) =>
  mount(createElement(QuietPins, null, createElement(ProvenancePin, { value: '$2,051.37', obs })));

describe('a quiet figure', () => {
  it('draws no glyph, and opens its source from the figure itself', async () => {
    const host = await quiet(LIVE_SPECIMEN);
    expect(host.querySelector('[data-ui="pin-glyph"]')).toBeNull();
    const pin = find(host, '[data-ui="pin"]');
    expect(pin.textContent).toBe('$2,051.37');
    expect(pin.getAttribute('aria-label')).toContain('$2,051.37');
    await click(pin);
    expect(pin.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain(LIVE_SPECIMEN.source);
  });

  it('keeps the hatched glyph on a sample figure', async () => {
    const host = await quiet({ ...LIVE_SPECIMEN, provenance: 'mock' });
    expect(find(host, '[data-ui="pin-glyph"]').getAttribute('data-state')).toBe('mock');
  });

  it('is drawn with its glyph everywhere else', async () => {
    const host = await mount(
      createElement(ProvenancePin, { value: '$2,051.37', obs: LIVE_SPECIMEN }),
    );
    expect(host.querySelector('[data-ui="pin-glyph"]')).not.toBeNull();
  });
});
