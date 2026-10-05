// @vitest-environment happy-dom
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, unmountAll } from './test/dom';
import { PARSED, sheetToBuild } from './test/events.cases';

// The sheet's own check, with the button's taken away: a button that calls its handler on every
// click, whatever it is told. An unvalidated sheet still never reaches `onBuild`.
vi.mock('./Button', () => ({
  Button: (props: { onClick?: () => void; children?: ReactNode }) =>
    createElement(
      'button',
      { type: 'button', 'data-naive': '', onClick: props.onClick },
      props.children,
    ),
}));

afterEach(unmountAll);

const build = (host: HTMLElement) => find(host, 'button[data-naive]');

describe('ConstraintSheet with a button that refuses nothing', () => {
  it('is wired to that button: a valid sheet builds', async () => {
    const onBuild = vi.fn();
    const host = await mount(sheetToBuild({ valid: PARSED }, onBuild));
    await click(build(host));
    expect(onBuild).toHaveBeenCalledTimes(1);
    expect(onBuild.mock.calls[0]?.[0]).toBe(PARSED);
  });

  it.each([
    ['a field does not fit', { wrong: true, valid: null }],
    ['the validator has not parsed it', { valid: null }],
    [
      'a field does not fit and a parsed sheet is handed over anyway',
      { wrong: true, valid: PARSED },
    ],
    [
      'the server refused it',
      { valid: PARSED, otherIssues: ['The server could not read the sheet.'] },
    ],
    ['a plan is already being built', { valid: PARSED, state: 'solving' }],
  ] as const)('still does not build when %s', async (_, sheet) => {
    const onBuild = vi.fn();
    const host = await mount(sheetToBuild(sheet, onBuild));
    await click(build(host));
    expect(onBuild).not.toHaveBeenCalled();
  });
});
