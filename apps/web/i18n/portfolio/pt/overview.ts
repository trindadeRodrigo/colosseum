import type { Overview } from '../en/overview';

// The overview of the portfolio section in Brazilian Portuguese: the same keys as en/overview.ts.
// "Retrato" for a snapshot is a proposal: Rodrigo owns this wording.

export const overview: Overview = {
  label: 'Visão geral',
  title: 'Seus planos ao longo do tempo.',
  lead: 'Cada plano fica em um cofre só dele. Lemos cada cofre mais ou menos a cada dez minutos e guardamos o que lemos. Esta página mostra como cada plano está e o que sustenta cada número. Nada aqui assina ou move coisa alguma.',
  count: (plans: number, chains: number) =>
    chains > 1
      ? `Você tem ${plans} planos em ${chains} redes. Os planos de cada rede são somados à parte, nunca entre redes.`
      : plans === 1
        ? 'Você tem 1 plano.'
        : `Você tem ${plans} planos.`,
  chain: {
    worth: (plans: number, chain: string) =>
      plans === 1 ? `Seu plano na ${chain} vale` : `Seus ${plans} planos na ${chain} valem`,
    method: (vaults: number, chain: string) =>
      vaults === 1
        ? `seu cofre na ${chain}, no retrato mais recente`
        : `seus ${vaults} cofres na ${chain}, cada um no retrato mais recente, somados`,
    unread: (vaults: number) =>
      vaults === 1
        ? '1 cofre ainda não foi lido, então não está nessa soma.'
        : `${vaults} cofres ainda não foram lidos, então não estão nessa soma.`,
    noneRead: (plans: number, chain: string) =>
      plans === 1
        ? `Seu plano na ${chain} ainda não foi lido, então nenhum valor é mostrado.`
        : `Seus ${plans} planos na ${chain} ainda não foram lidos, então nenhum valor é mostrado.`,
    none: (chain: string) => `Você ainda não tem plano na ${chain}.`,
    answered: (chain: string, when: string) => `A ${chain} foi lida pela última vez em ${when}.`,
    neverAnswered: (chain: string) => `A ${chain} ainda não foi lida.`,
  },
  card: {
    follows: (name: string) => `Seu cofre segue ${name}.`,
    openedFor: (name: string) => `Seu cofre foi aberto para seguir ${name}.`,
    followsShared: 'Seu cofre segue um portfólio compartilhado.',
    openedAs: (name: string) => `Ele foi aberto para seguir ${name}.`,
    unknown: (chain: string) => `Seu cofre na ${chain}.`,
    value: 'Valor agora',
    putIn: 'Você colocou',
    noPutIn: 'Nenhum depósito seu por este app está confirmado para este cofre ainda.',
    neverRead: 'Este cofre ainda não foi lido, então nenhum valor é mostrado.',
    unpriced: (n: number) =>
      n === 1
        ? '1 posição não tem preço, então o valor a deixa de fora.'
        : `${n} posições não têm preço, então o valor as deixa de fora.`,
    read: (age: string, when: string) => `Lido há ${age}, em ${when}.`,
    open: 'Ver este plano ao longo do tempo',
  },
  board: {
    total: 'Valor total do portfólio',
    vaults: 'Cofres',
    netIn: 'Depositado líquido',
    netInMethod:
      'Depósitos confirmados por este app, menos saques confirmados pelo valor na hora do pedido.',
    allTime: 'PnL total',
    allTimeMethod: 'O valor no retrato mais recente, menos o que entrou: depósitos menos saques.',
    periodMethod:
      'A variação do valor no período, pelos retratos guardados, menos o que foi depositado ou sacado nele.',
    chartMethod: 'Seus cofres somados em cada retrato guardado.',
    pnl: 'PnL',
    gaining: 'Cofres no positivo',
    best: 'Melhor cofre',
    noPnl: 'Ainda não há leituras suficientes neste período.',
    leftOut: (kind: string) => `Cofres em ${kind} não entram na soma.`,
    kinds: {
      sandbox: 'rede de teste',
      mock: 'rede de exemplo',
      live: 'rede real',
      fixture: 'rede de exemplo',
      prior_dataset: 'rede de exemplo',
    },
    unvalued: (n: number) =>
      n === 1
        ? '1 saque não tinha preço na hora do pedido, então o depositado líquido o deixa de fora.'
        : `${n} saques não tinham preço na hora do pedido, então o depositado líquido os deixa de fora.`,
    chart: {
      label: 'Gráfico',
      line: 'Linha',
      byVault: 'Por cofre',
      byAsset: 'Por ativo',
      period: 'Período',
      periods: { '1d': '1D', '7d': '7D', '30d': '30D', '1y': '1A', ytd: 'No ano', all: 'Tudo' },
      plot: (from: string, to: string) => `Valor dos seus cofres de ${from} a ${to}`,
      bars: (from: string, to: string) => `Valor dos seus cofres, empilhado, de ${from} a ${to}`,
      up: 'Acima do que você depositou',
      down: 'Abaixo do que você depositou',
      cash: 'Caixa',
      empty:
        'Ainda não há leituras neste período. Uma leitura é feita mais ou menos a cada dez minutos.',
      reading: 'Lendo o histórico…',
      hint: 'Aponte para o gráfico, ou use as setas, para ler um dia.',
    },
  },
  table: {
    heading: 'Cofres',
    vault: 'Cofre',
    chain: 'Rede',
    value: 'Valor',
    netIn: 'Depositado líquido',
    allTime: 'PnL total',
    period: (period: string) => `PnL ${period}`,
    status: 'Situação',
    open: (vault: string) => `Abrir ${vault}`,
    newPlan: 'Novo plano',
    neverRead: 'Ainda não lido',
  },
  refresh: 'Um novo retrato é tirado mais ou menos a cada dez minutos.',
};
