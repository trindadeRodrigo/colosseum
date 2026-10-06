// @vitest-environment happy-dom
import type { BasketLine } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { find, mount, settle, unmountAll } from '../../components/ui/test/dom';
import { dictionary, type Lang } from '../../i18n';
import type { Person } from '../account/person';
import { withAccount } from '../account/test/screen';
import { EMBEDDED, json, signedInPort } from '../wallet/test/fake-port';
import { portStore } from '../wallet/test/mock-provider';
import { PlanScreen } from './PlanScreen';
import { rememberChoice, rememberPlan, type StoredPlan } from './plan-store';
import { PLAN_ID, planOn, USER } from './test/fixtures';
import { themesOf, whyOf } from './themes';

vi.mock('../wallet/WalletProvider', () => import('../wallet/test/mock-provider'));
vi.mock('next/navigation', () => import('../wallet/test/mock-next'));
vi.mock('next/link', () => import('../wallet/test/mock-next'));

// A plan with a theme sleeve (gates SLEEVES, THEMES): the share the person set for the theme and,
// for each name it holds, why the name is on the theme's list, as the engine wrote them on the lines.

const en = dictionary('en');
const sleeve = (shareBps: number) => ({
  rule: 'THEME_SLEEVE',
  inputs: ['sleeves', 'themes', 'chain'],
  params: { shareBps, theme: 'AI', chain: 'solana' },
  text: 'You set 50% of the plan for the theme AI: equal shares of the names on its list for Solana that you can hold and that can be sold at this size, each up to its limit.',
});
const member = (asset: string, why: string) => ({
  rule: 'THEME_MEMBER',
  inputs: ['themes', 'chain'],
  params: { asset, theme: 'AI', chain: 'solana', version: 1, curator: 'Rodrigo', why },
  text: `${asset} is on the AI list for Solana, version 1, kept by Rodrigo: ${why}.`,
});
const NVDA = 'Nvidia makes most of the chips used to train and run AI models';
const TSLA = 'Tesla builds self-driving software trained on its own fleet';

function themed(): StoredPlan {
  const base = planOn('solana', 'sandbox');
  const [first, second, ...rest] = base.proposal.lines as [BasketLine, BasketLine, ...BasketLine[]];
  return {
    ...base,
    proposal: {
      ...base.proposal,
      lines: [
        { ...first, reasons: [sleeve(5000), member('NVDAx', NVDA), ...first.reasons] },
        { ...second, reasons: [sleeve(5000), member('TSLAx', TSLA)] },
        ...rest,
      ],
    },
  };
}

const person: Person = {
  userId: USER,
  wallets: EMBEDDED,
  chain: 'solana',
  chainSource: 'picked',
  chainOptions: [],
};
const shown = async (id: string, lang: Lang = 'en') => {
  const host = await mount(withAccount(lang, createElement(PlanScreen, { id })));
  await settle();
  await settle();
  return host;
};

beforeEach(() => {
  window.sessionStorage.clear();
  portStore.set(signedInPort(EMBEDDED, { userId: USER }));
  portStore.setApi(async (path) =>
    path === '/v1/me' ? json(person) : json({ error: 'not found' }, 404),
  );
});
afterEach(unmountAll);

describe('a theme sleeve', () => {
  it('is read from the lines: the theme, its share, and each name with why it is on the list', () => {
    const lines = themed().proposal.lines;
    expect(themesOf(lines)).toEqual([
      {
        theme: 'AI',
        shareBps: 5000,
        names: [
          { line: lines[0], why: member('NVDAx', NVDA).text },
          { line: lines[1], why: member('TSLAx', TSLA).text },
        ],
      },
    ]);
    // a name's first reason is why it is on the list; any other line keeps its own first
    expect(whyOf(lines[0] as BasketLine)).toBe(member('NVDAx', NVDA).text);
    expect(whyOf(lines[2] as BasketLine)).toBe((lines[2] as BasketLine).reasons[0]?.text);
    expect(themesOf(planOn().proposal.lines)).toEqual([]);
  });

  it('shows on the plan its share and why each name is there', async () => {
    rememberPlan(themed());
    const host = await shown(PLAN_ID);
    const block = find(host, '[data-ui="plan-themes"]');
    expect(find(block, 'h3').textContent).toBe(en.plan.theme.label);
    expect(find(block, '[data-theme="AI"] p').textContent).toBe(en.plan.theme.share('AI', '50%'));
    expect([...block.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      member('NVDAx', NVDA).text,
      member('TSLAx', TSLA).text,
    ]);
  });

  it('shows on each candidate beside the others, too', async () => {
    const plan = themed();
    const ids = ['1c0a7e3b-5d2f-4a6b-8c9d-0e1f2a3b4c5d', '2d1b8f4c-6e3a-4b7c-9d0e-1f2a3b4c5d6e'];
    const scorecard = {
      monthsCovered: null,
      base: null,
      stresses: [],
      carryObservedBps: 0,
      exit: { costBps: null, measuredShareBps: 0 },
      concentration: { byIssuer: [], byClass: [], largestIssuerBps: 0, issuers: 0 },
      creditBasisBps: 0,
    };
    rememberPlan({ ...plan, id: ids[0] as string, candidate: { name: 'cover', scorecard } });
    rememberPlan({ ...planOn(), id: ids[1] as string, candidate: { name: 'carry', scorecard } });
    rememberChoice({ key: 'k-1', userId: USER, ids, notShown: [] });
    const host = await shown('k-1');
    const [cover, carry] = [...host.querySelectorAll('section[data-candidate]')];
    expect(cover?.querySelector('[data-ui="plan-themes"]')?.textContent).toContain(
      en.plan.theme.share('AI', '50%'),
    );
    expect(carry?.querySelector('[data-ui="plan-themes"]')).toBeNull();
  });

  it('is said in Portuguese around the engine’s own sentences', async () => {
    rememberPlan(themed());
    const host = await shown(PLAN_ID, 'pt');
    expect(find(host, '[data-theme="AI"] p').textContent).toBe(
      dictionary('pt').plan.theme.share('AI', '50%'),
    );
  });
});
