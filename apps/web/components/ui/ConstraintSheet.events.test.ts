// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, unmountAll } from './test/dom';
import { PARSED, sheetToBuild } from './test/events.cases';

afterEach(unmountAll);

const build = (host: HTMLElement) => find(host, 'button[data-variant="primary"]');

// CLAUDE.md: "the solver never runs on unvalidated input". The sheet is where a person asks for the
// plan, so nothing but the sheet the validator parsed may leave it.
describe('ConstraintSheet, "Build my plan" clicked (constraint-sheet.md)', () => {
  it('hands on the parsed sheet, and only that, when everything fits', async () => {
    const onBuild = vi.fn();
    const host = await mount(sheetToBuild({ valid: PARSED }, onBuild));
    await click(build(host));
    expect(onBuild).toHaveBeenCalledTimes(1);
    expect(onBuild.mock.calls[0]?.[0]).toBe(PARSED);
  });

  it('does not build while a field does not fit, and moves focus to what to fix', async () => {
    const onBuild = vi.fn();
    const host = await mount(sheetToBuild({ wrong: true, valid: null }, onBuild));
    await click(build(host));
    await click(build(host));
    expect(onBuild).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(find(host, '[data-ui="sheet-errors"]'));
  });

  it('does not build a sheet the validator has not parsed, even with no field marked', async () => {
    const onBuild = vi.fn();
    const host = await mount(sheetToBuild({ valid: null }, onBuild));
    await click(build(host));
    expect(onBuild).not.toHaveBeenCalled();
  });

  it('does not build while anything is left to fix, even if it is handed a parsed sheet', async () => {
    const onBuild = vi.fn();
    const fields = await mount(sheetToBuild({ wrong: true, valid: PARSED }, onBuild));
    await click(build(fields));
    const server = await mount(
      sheetToBuild(
        { valid: PARSED, otherIssues: ['The server could not read the sheet.'] },
        onBuild,
      ),
    );
    await click(build(server));
    expect(onBuild).not.toHaveBeenCalled();
  });

  it('does not build again while a plan is being built', async () => {
    const onBuild = vi.fn();
    const host = await mount(sheetToBuild({ valid: PARSED, state: 'solving' }, onBuild));
    await click(build(host));
    expect(onBuild).not.toHaveBeenCalled();
  });
});
