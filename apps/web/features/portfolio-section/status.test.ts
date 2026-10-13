import { TRACK_RULE, TrackLine, type TrackStatus } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { dictionary, type Lang } from '../../i18n';
import { portfolioDictionary } from '../../i18n/portfolio';
import { displayName } from '../order/plain';
import { sayStatus } from './status';
import { STATUS_BY_LINE } from './test/fixtures';

// A plan's status as a page says it: the server's word with its shape, and one sentence for the line
// of the rule that gave it, in the person's language, made from the figures the line names. Every
// line of the rule is said here, in both languages.

const say = (status: TrackStatus, lang: Lang = 'en') =>
  sayStatus(status, lang, portfolioDictionary(lang).status, (asset) =>
    displayName(asset, dictionary(lang).plan),
  );
const first = (line: TrackLine): TrackStatus => STATUS_BY_LINE[line][0] as TrackStatus;

describe('a status, as a page says it', () => {
  it('takes the word and the shape from the server’s status, and never from its English sentence', () => {
    for (const lang of ['en', 'pt'] as const) {
      const words = portfolioDictionary(lang).status;
      for (const answered of Object.values(STATUS_BY_LINE).flat()) {
        // the server's own sentence is not what is shown, whatever it says
        const status = { ...answered, text: 'the server’s own English sentence' };
        const said = say(status, lang);
        expect(said.line).toBe(status.line);
        expect(said.rule).toBe(status.rule);
        expect(said.reason).not.toContain(status.text);
        expect(said.reason).toBe(say(answered, lang).reason);
        expect(said.reason).not.toBe(words.noFigures);
        expect(said.reason).toMatch(/[.]$/);
        if (status.status === null) {
          expect([said.kind, said.word]).toEqual([null, words.none]);
        } else {
          expect(said.word).toBe(words.words[status.status]);
          expect(said.kind).toBe(
            { on_track: 'on-track', watch: 'watch', off_track: 'off-track' }[status.status],
          );
        }
      }
    }
  });

  it('says the three words as decided, in English and in Portuguese', () => {
    expect(portfolioDictionary('en').status.words).toEqual({
      on_track: 'On track',
      watch: 'Watch',
      off_track: 'Off track',
    });
    expect(portfolioDictionary('pt').status.words).toEqual({
      on_track: 'No caminho',
      watch: 'Atenção',
      off_track: 'Fora do caminho',
    });
  });

  it('has a sentence for every line of the rule, with the figures the line names (English)', () => {
    const reasons = Object.fromEntries(
      TrackLine.options.map((line) => [line, STATUS_BY_LINE[line].map((s) => say(s).reason)]),
    );
    expect(reasons).toEqual({
      verdict: [
        'Your goal is covered now, and under the stress cases too. Observed on 2026-10-07.',
        'Your goal is covered now. No stress case was run.',
        'Your goal is covered now, but not under the stress cases.',
        'Your goal is not covered now.',
      ],
      never_read: ['This vault hasn’t been read yet, so there is no status to give.'],
      empty: [
        'The vault holds nothing yet. A deposit counts once the chain shows the vault holding it.',
      ],
      chain_silent: [
        'Nothing has been read from this plan’s chain for 26 hours, a day or more, so I can’t say where it stands.',
      ],
      loss_half: ['Our keeper’s losses have used 62% of their budget, half or more.'],
      unpriced: [
        'PAXG is held and has no price, so the plan can’t be weighed.',
        '2 parts you hold have no price, PAXG first, so the plan can’t be weighed.',
      ],
      no_band: [
        'This chain doesn’t state how far a part may drift from its planned share, so there is nothing to hold the parts to.',
      ],
      outside_band: [
        'USDY (Ondo) is 3.5% over its planned share, more than the 2% it may drift.',
        'SPYx is 4.2% under its planned share, more than the 2% it may drift.',
      ],
      cash_over: ['Cash is 3.5% over its share of the plan, more than the 2% it may drift.'],
      loss_quarter: ['Our keeper’s losses have used 31% of their budget, a quarter or more.'],
      stale: ['The vault was last read 185 minutes ago, more than an hour.'],
      inside: [
        'Every part is within 2% of its planned share, and our keeper’s losses have used 12% of their budget.',
      ],
      inside_no_budget: [
        'Every part is within 2% of its planned share. This chain keeps no loss budget.',
      ],
    });
  });

  it('has a sentence for every line of the rule, with the figures the line names (Portuguese)', () => {
    const reasons = Object.fromEntries(
      TrackLine.options.map((line) => [line, STATUS_BY_LINE[line].map((s) => say(s, 'pt').reason)]),
    );
    expect(reasons).toEqual({
      verdict: [
        'Seu objetivo está coberto agora, e também nos cenários de estresse. Observado em 2026-10-07.',
        'Seu objetivo está coberto agora. Nenhum cenário de estresse foi rodado.',
        'Seu objetivo está coberto agora, mas não nos cenários de estresse.',
        'Seu objetivo não está coberto agora.',
      ],
      never_read: ['Este cofre ainda não foi lido, então não há situação para dar.'],
      empty: [
        'O cofre ainda não guarda nada. Um depósito conta quando a rede mostra o cofre com ele.',
      ],
      chain_silent: [
        'Nada foi lido da rede deste plano há 26 horas, um dia ou mais, então não sei dizer como ele está.',
      ],
      loss_half: ['As perdas do nosso operador usaram 62% do orçamento delas, metade ou mais.'],
      unpriced: [
        'PAXG está no cofre e não tem preço, então o plano não pode ser pesado.',
        '2 partes que você tem estão sem preço, a começar por PAXG, então o plano não pode ser pesado.',
      ],
      no_band: [
        'Esta rede não diz quanto uma parte pode se afastar da fatia planejada, então não há com o que comparar as partes.',
      ],
      outside_band: [
        'USDY (Ondo) está 3,5% acima da fatia planejada, mais do que os 2% que pode se afastar.',
        'SPYx está 4,2% abaixo da fatia planejada, mais do que os 2% que pode se afastar.',
      ],
      cash_over: [
        'O caixa está 3,5% acima da fatia dele no plano, mais do que os 2% que pode se afastar.',
      ],
      loss_quarter: [
        'As perdas do nosso operador usaram 31% do orçamento delas, um quarto ou mais.',
      ],
      stale: ['O cofre foi lido pela última vez há 185 minutos, mais de uma hora.'],
      inside: [
        'Toda parte está a até 2% da fatia planejada, e as perdas do nosso operador usaram 12% do orçamento delas.',
      ],
      inside_no_budget: [
        'Toda parte está a até 2% da fatia planejada. Esta rede não mantém orçamento de perdas.',
      ],
    });
  });

  it('prints the rule that gave the status: this one, or the rule of a verdict that was handed in', () => {
    expect(say(first('inside')).rule).toBe(TRACK_RULE);
    expect(say(first('verdict')).rule).toBe('ENG-3 income verdict v1');
    expect(portfolioDictionary('en').status.rule(TRACK_RULE)).toBe('Rule ON-TRACK-V1');
    expect(portfolioDictionary('pt').status.rule(TRACK_RULE)).toBe('Regra ON-TRACK-V1');
  });

  it('makes up no sentence when a line comes without its figures, or with another kind of thing', () => {
    for (const lang of ['en', 'pt'] as const) {
      const { noFigures } = portfolioDictionary(lang).status;
      for (const line of TrackLine.options) {
        const status = first(line);
        const bare = say({ ...status, params: {} }, lang);
        // the lines that name no figure still have their sentence
        if (Object.keys(status.params).length === 0) expect(bare.reason).not.toBe(noFigures);
        else expect(bare.reason, line).toBe(noFigures);
        // the word and the shape are the server's all the same
        expect(bare.word).toBe(say(status, lang).word);
      }
      const wrong = { ...first('stale'), params: { minutes: 'soon' } };
      expect(say(wrong, lang).reason).toBe(noFigures);
    }
  });
});
