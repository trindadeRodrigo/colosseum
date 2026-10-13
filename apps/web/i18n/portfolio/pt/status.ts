import type { Status } from '../en/status';

// A plan's status in Brazilian Portuguese: the same keys as en/status.ts. The three words are a
// proposal: Rodrigo owns this wording.

export const status: Status = {
  words: {
    on_track: 'No caminho',
    watch: 'Atenção',
    off_track: 'Fora do caminho',
  },
  none: 'Ainda sem situação',
  rule: (name: string) => `Regra ${name}`,
  noFigures: 'Nosso servidor deu esta situação sem os números por trás dela.',
  lines: {
    verdict: {
      coveredBoth: 'Seu objetivo está coberto agora, e também nos cenários de estresse.',
      coveredNoStress: 'Seu objetivo está coberto agora. Nenhum cenário de estresse foi rodado.',
      coveredNotStress: 'Seu objetivo está coberto agora, mas não nos cenários de estresse.',
      notCovered: 'Seu objetivo não está coberto agora.',
      observedOn: (day: string) => `Observado em ${day}.`,
    },
    never_read: 'Este cofre ainda não foi lido, então não há situação para dar.',
    empty: 'O cofre ainda não guarda nada. Um depósito conta quando a rede mostra o cofre com ele.',
    chain_silent: (hours: number) =>
      `Nada foi lido da rede deste plano há ${hours} horas, um dia ou mais, então não sei dizer como ele está.`,
    loss_half: (used: string) =>
      `As perdas do nosso operador usaram ${used} do orçamento delas, metade ou mais.`,
    unpriced: {
      one: (asset: string) =>
        `${asset} está no cofre e não tem preço, então o plano não pode ser pesado.`,
      many: (count: number, asset: string) =>
        `${count} partes que você tem estão sem preço, a começar por ${asset}, então o plano não pode ser pesado.`,
    },
    no_band:
      'Esta rede não diz quanto uma parte pode se afastar da fatia planejada, então não há com o que comparar as partes.',
    outside_band: {
      over: (asset: string, by: string, band: string) =>
        `${asset} está ${by} acima da fatia planejada, mais do que os ${band} que pode se afastar.`,
      under: (asset: string, by: string, band: string) =>
        `${asset} está ${by} abaixo da fatia planejada, mais do que os ${band} que pode se afastar.`,
    },
    cash_over: (by: string, band: string) =>
      `O caixa está ${by} acima da fatia dele no plano, mais do que os ${band} que pode se afastar.`,
    loss_quarter: (used: string) =>
      `As perdas do nosso operador usaram ${used} do orçamento delas, um quarto ou mais.`,
    stale: (minutes: number) =>
      `O cofre foi lido pela última vez há ${minutes} minutos, mais de uma hora.`,
    inside: (band: string, used: string) =>
      `Toda parte está a até ${band} da fatia planejada, e as perdas do nosso operador usaram ${used} do orçamento delas.`,
    inside_no_budget: (band: string) =>
      `Toda parte está a até ${band} da fatia planejada. Esta rede não mantém orçamento de perdas.`,
  },
};
