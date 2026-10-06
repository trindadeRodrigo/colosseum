import { describe, expect, it } from 'vitest';
import { read, sourceFiles } from './test/css';

// No text is set under 12px (the design pass, Oct 6): chart ticks, pane feet and unit slots included.
// The type scale's smallest steps are 12px (`text-b-meta`, `text-b-head`) and 12.5px (`text-caption`);
// a size written by hand in a component is held to the same floor, in a class or in an inline style.

const FLOOR_PX = 12;

/** Every size under the floor written by hand in one file: `text-[11px]`, `fontSize: 10`, `0.7rem`. */
export function smallSizes(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/text-\[(\d+(?:\.\d+)?)(px|rem)\]/g)) {
    const px = Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
    if (px < FLOOR_PX) found.push(m[0]);
  }
  for (const m of text.matchAll(/fontSize[=:]\s*\{?\s*(\d+(?:\.\d+)?)\b/g))
    if (Number(m[1]) < FLOOR_PX) found.push(m[0]);
  for (const m of text.matchAll(/font-size:\s*(\d+(?:\.\d+)?)(px|rem)/g)) {
    const px = Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
    if (px < FLOOR_PX) found.push(m[0]);
  }
  return found;
}

const app = [...sourceFiles()].filter(
  (file) =>
    /^(app|components|features)\//.test(file) &&
    /\.(tsx?|css)$/.test(file) &&
    !/\.test\.ts$|\/test\/|^app\/\(structurer\)/.test(file),
);

describe('the size of text', () => {
  it('is 12px or more everywhere the app sets one by hand', () => {
    const under = app.flatMap((file) => smallSizes(read(file)).map((size) => `${file}: ${size}`));
    expect(under).toEqual([]);
  });

  it('bites: a tick, a foot or a unit slot set smaller is found', () => {
    expect(smallSizes('<text className="font-mono text-[11px]">1</text>')).toEqual(['text-[11px]']);
    expect(smallSizes('const MONO = { fontSize: 10 };')).toEqual(['fontSize: 10']);
    expect(smallSizes('<p className="text-[0.7rem]">x</p>')).toEqual(['text-[0.7rem]']);
    expect(smallSizes('<p className="text-[12px] text-[0.75rem]">x</p>')).toEqual([]);
  });
});
