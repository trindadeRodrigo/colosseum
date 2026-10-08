// @vitest-environment happy-dom
import type { PlanCandidateId } from '@colosseum/schemas';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { click, find, mount, unmountAll } from '../../components/ui/test/dom';
import { hatchProblems } from '../../components/ui/test/hatch';
import { parse } from '../../components/ui/test/html';
import { dictionary } from '../../i18n';
import { inLanguage } from '../account/test/screen';
import { SHEET } from '../goal/test/plan';
import { Candidates } from './Candidates';
import { candidateFor } from './test/candidates';

// The plans of one goal, side by side (gate THREE-PLANS): the fixed order, none picked or marked,
// each with its headline, its bar and what it is compared on, and the ones left out with why.

const en = dictionary('en');
const words = en.plan.choice;
const ORDER = ['cover', 'spread', 'carry'] as const;
const shown = async (
  o: {
    names?: readonly PlanCandidateId[];
    onPick?: (c: PlanCandidateId) => void;
    onWay?: (way: string) => void;
    disabled?: boolean;
    over?: Parameters<typeof candidateFor>[2];
    lang?: 'en' | 'pt';
  } = {},
) =>
  mount(
    inLanguage(
      o.lang ?? 'en',
      createElement(Candidates, {
        candidates: (o.names ?? ORDER).map((name) => candidateFor(SHEET, name, o.over)),
        notShown: ORDER.filter((name) => !(o.names ?? ORDER).includes(name)).map((candidate) => ({
          candidate,
          why: 'It came out the same as Cover.',
        })),
        chain: 'solana',
        onPick: o.onPick ?? (() => {}),
        onWay: o.onWay,
        disabled: o.disabled,
      }),
    ),
  );
const cards = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLElement>('section[data-candidate]'),
];
afterEach(unmountAll);

describe('the candidates, side by side', () => {
  it('are in the fixed order by their names, with none picked, marked or first by any word', async () => {
    const host = await shown();
    expect(cards(host).map((c) => c.getAttribute('data-candidate'))).toEqual([...ORDER]);
    expect(cards(host).map((c) => c.querySelector('h3')?.textContent)).toEqual([
      'Cover',
      'Spread',
      'Carry',
    ]);
    // nothing says one is the one to take
    expect(
      host.querySelector('[aria-pressed="true"], [aria-checked="true"], [aria-selected], input'),
    ).toBeNull();
    expect(host.textContent).not.toMatch(/recommend|best|suggest|popular|default|we picked/i);
    expect(host.querySelectorAll('[data-variant="primary"]')).toHaveLength(0);
    // every card is the same card: the same rows, the same button
    const rows = cards(host).map((c) =>
      [...c.querySelectorAll('[data-ui="candidate-score"] dt')].map((dt) => dt.textContent),
    );
    expect(rows[1]).toEqual(rows[0]);
    expect(rows[2]).toEqual(rows[0]);
    expect(
      cards(host).map((c) => find(c, '[data-ui="candidate-pick"] button').textContent),
    ).toEqual(['Choose Cover', 'Choose Spread', 'Choose Carry']);
    expect(hatchProblems(parse(host.innerHTML))).toEqual([]);
  });

  it('gives each its headline from the engine’s figures, its bar as a picture, and its scorecard on pins', async () => {
    const host = await shown();
    const [cover, , carry] = cards(host) as [HTMLElement, HTMLElement, HTMLElement];
    // three figures in a row, the engine's own: the yield and the selling cost on their pins, and
    // what a bad fall would cost
    const figure = (card: HTMLElement, key: string) =>
      find(card, `[data-ui="candidate-figures"] [data-figure="${key}"]`);
    expect(
      [...cover.querySelectorAll('[data-ui="candidate-figures"] [data-figure]')].map((d) =>
        d.getAttribute('data-figure'),
      ),
    ).toEqual(['yield', 'exit', 'fall']);
    expect(figure(cover, 'yield').textContent).toContain('2%');
    expect(figure(cover, 'yield').querySelector('[data-ui="pin"]')).not.toBeNull();
    expect(figure(cover, 'exit').textContent).toContain('0.1%');
    expect(figure(cover, 'exit').querySelector('[data-ui="pin"]')).not.toBeNull();
    expect(figure(cover, 'fall').textContent).toBe(
      `${words.figures.fall}${words.figures.lost('$1,000')}`,
    );
    expect(figure(carry, 'fall').textContent).toContain('−$3,000');
    // one row a candidate: the name, the aim and the button are not squeezed into columns
    expect(find(host, '[data-ui="plan-candidates"] > div.grid').className).not.toMatch(
      /(^|\s)(sm|md|lg|xl|2xl):grid-cols/,
    );
    const bar = find(cover, '[data-ui="candidate-bar"] [role="img"]');
    expect(bar.getAttribute('aria-label')).toMatch(/, 60%; .*, 40%$/);
    expect(bar.querySelector('button, a, [tabindex]')).toBeNull();
    // the yield observed and the cost to sell: each on its pin
    const row = (card: HTMLElement, term: string) =>
      [...card.querySelectorAll('[data-ui="candidate-score"] > div')].find(
        (div) => div.querySelector('dt')?.textContent === term,
      ) as HTMLElement;
    expect(row(cover, words.score.carry).textContent).toContain('2%');
    expect(row(carry, words.score.carry).textContent).toContain('4%');
    expect(row(cover, words.score.carry).querySelector('[data-ui="pin"]')).not.toBeNull();
    expect(row(cover, words.score.exit).textContent).toContain('0.1%');
    expect(row(cover, words.score.exit).querySelector('[data-ui="pin"]')).not.toBeNull();
    expect(row(carry, words.score.issuer).textContent).toContain(words.score.issuers(4));
    // no return is promised and no odds are given
    expect(host.textContent).not.toMatch(/guarantee|will earn|chance|probab|odds/i);
  });

  it('never shows an exit cost that is not measured as zero', async () => {
    const base = candidateFor(SHEET, 'cover');
    const host = await shown({
      names: ['cover'],
      over: { scorecard: { ...base.scorecard, exit: { costBps: null, measuredShareBps: 0 } } },
    });
    const exit = [...host.querySelectorAll('[data-ui="candidate-score"] > div')].find(
      (div) => div.querySelector('dt')?.textContent === words.score.exit,
    );
    expect(exit?.textContent).toContain(words.score.exitNone);
    expect(exit?.querySelector('[data-ui="pin"]')).toBeNull();
  });

  it('with withdrawals to come, leads with the months paid and the worst stress, and offers the engine’s ways per candidate', async () => {
    const base = candidateFor(SHEET, 'cover');
    const counted = { monthsPaid: 30, monthsWithWithdrawal: 36, shortfall: 1200 };
    const onWay = vi.fn();
    const host = await shown({
      names: ['cover', 'carry'],
      onWay,
      over: {
        scorecard: {
          ...base.scorecard,
          monthsCovered: 12,
          base: counted,
          stresses: [{ id: 'yields_fall', monthsPaid: 24, shortfall: 4000 }],
        },
        status: {
          observedOn: '2026-10-05',
          base: counted,
          stresses: [{ ...counted, id: 'yields_fall', monthsPaid: 24, params: { fallBps: 200 } }],
          carryObservedBps: 400,
          carryNeededBps: 650,
          met: false,
          ways: [{ change: 'You can put in $9,000 more, $49,000 in all.', closesGap: true }],
        },
      },
    });
    const cover = cards(host)[0] as HTMLElement;
    // the months paid is a figure of its own, on the yield's pin, and the stress is in the scorecard
    const paid = find(cover, '[data-ui="candidate-figures"] [data-figure="paid"]');
    expect(paid.textContent).toContain(words.score.of(30, 36));
    expect(paid.querySelector('[data-ui="pin"]')).not.toBeNull();
    expect(find(cover, '[data-ui="candidate-score"]').textContent).toContain(
      words.score.paidUnder(words.stress.yields_fall('2%')),
    );
    // the yield observed, inside the sentence that says what is needed, is on its pin too
    const said = find(cover, '[data-ui="candidate-status"]');
    expect(said.textContent).toContain('Needs 6.5% a year on its dollar yield, and 4%');
    const observed = [...said.querySelectorAll('[data-ui="figure"]')];
    expect(observed).toHaveLength(1);
    expect(observed[0]?.querySelector('[data-ui="pin"]')).not.toBeNull();
    // with a gap to close, what closes it is in view, not behind a fold
    expect(find<HTMLDetailsElement>(cover, '[data-ui="candidate-details"]').open).toBe(true);
    // the way is the engine's own sentence, on each candidate that has it
    const ways = [...host.querySelectorAll('[data-ui="candidate-ways"] button')];
    expect(ways).toHaveLength(2);
    expect(ways[0]?.textContent).toBe('You can put in $9,000 more, $49,000 in all.');
    await click(ways[0] as HTMLElement);
    expect(onWay).toHaveBeenCalledWith('You can put in $9,000 more, $49,000 in all.');
  });

  it('puts what is owed in another currency on the pin of the rate it was read at', async () => {
    const base = candidateFor(SHEET, 'cover');
    const fx = {
      id: 'USDBRL',
      kind: 'fx' as const,
      source: 'a test rate',
      method: 'fixture',
      fetchedAt: '2026-10-05T12:00:00.000Z',
      provenance: 'sandbox' as const,
    };
    const host = await shown({
      names: ['cover'],
      over: {
        proposal: { ...base.proposal, observations: [...base.proposal.observations, fx] },
        scorecard: { ...base.scorecard, openFxUsd: 1200 },
      },
    });
    const cover = cards(host)[0] as HTMLElement;
    const owed = [...cover.querySelectorAll('[data-ui="candidate-score"] > div')].find(
      (row) => row.querySelector('dt')?.textContent === words.score.fx,
    ) as HTMLElement;
    expect(owed.querySelector('dd')?.textContent).toContain('$1,200');
    expect(owed.querySelector('[data-ui="pin"]')).not.toBeNull();
    // with no rate read, the amount is not shown as a bare number
    await unmountAll();
    const unread = await shown({
      names: ['cover'],
      over: { scorecard: { ...base.scorecard, openFxUsd: 1200 } },
    });
    const row = [...unread.querySelectorAll('[data-ui="candidate-score"] > div')].find(
      (r) => r.querySelector('dt')?.textContent === words.score.fx,
    ) as HTMLElement;
    expect(row.querySelector('dd')?.textContent).not.toContain('$1,200');
    expect(find(row, '[data-ui="figure"]').getAttribute('data-state')).toBe('missing');
  });

  it('names the candidates the engine did not offer, each with its reason', async () => {
    const host = await shown({ names: ['cover', 'carry'] });
    expect(cards(host)).toHaveLength(2);
    const out = find(host, '[data-ui="candidates-not-shown"]');
    expect(find(out, 'li[data-candidate="spread"]').textContent).toBe(
      'Spread: It came out the same as Cover.',
    );
  });

  it('picks the one that is pressed, and none while the plans are from before a change', async () => {
    const onPick = vi.fn();
    const host = await shown({ onPick });
    await click(find(cards(host)[1] as HTMLElement, '[data-ui="candidate-pick"] button'));
    expect(onPick).toHaveBeenCalledWith('spread');
    await unmountAll();
    const stale = await shown({ onPick, disabled: true });
    for (const button of stale.querySelectorAll('[data-ui="candidate-pick"] button'))
      expect(
        button.getAttribute('aria-disabled') ?? (button as HTMLButtonElement).disabled,
      ).toBeTruthy();
  });

  it('is named in Portuguese by the Portuguese names', async () => {
    const host = await shown({ lang: 'pt' });
    expect(cards(host).map((c) => c.querySelector('h3')?.textContent)).toEqual([
      'Cobertura',
      'Diversificação',
      'Rendimento',
    ]);
  });
});
