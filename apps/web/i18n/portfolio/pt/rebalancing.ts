import type { Rebalancing } from '../en/rebalancing';

// The rebalancing page in Brazilian Portuguese: the same keys as en/rebalancing.ts. The words follow
// the methodology's ("passo", "operação", "cotação", "montado", "nosso operador", "leitura",
// "deduzido"); "custo cotado", "passo seu" and "no cofre antes" are proposals: Rodrigo owns this
// wording.

export const rebalancing: Rebalancing = {
  label: 'Rebalanceamento',
  title: 'O que o rebalanceamento fez.',
  lead: 'Os passos que negociaram nos seus cofres, ou que adotaram uma nova versão do portfólio que um cofre segue. Dos mais recentes para os mais antigos, cofre por cofre. Nada aqui assina ou move coisa alguma.',
  empty: 'Ainda não há passos para listar. Eles aparecem aqui quando um dos seus planos negociar.',
  noneRead: 'Não há passos para listar nas redes que foram lidas.',
  capped: (limit: number, chain: string) =>
    `Só os ${limit} passos mais recentes na ${chain} estão listados. Os mais antigos não aparecem.`,
  refresh:
    'Um passo seu aparece aqui assim que nosso servidor o tem. Uma operação do nosso operador aparece depois da próxima leitura do cofre.',
  group: {
    unnamed: (chain: string) => `Seu cofre na ${chain}`,
    count: (steps: number) => (steps === 1 ? '1 passo' : `${steps} passos`),
    unknown: (chain: string) => `Passos na ${chain} sem cofre identificado`,
    unknownWhy:
      'Nosso servidor não associou estes passos a um dos seus cofres, então esta lista não sabe dizer de qual cofre eles são.',
  },
  when: {
    built: 'quando o passo foi montado',
    chain: 'hora da operação segundo a rede',
  },
  by: {
    owner: 'Passo seu',
    keeper: 'Passo do nosso operador',
  },
  outcome: {
    confirmed: 'Confirmado',
    failed: 'Falhou',
  },
  why: {
    manual: 'Este passo foi feito por você.',
    index_update: 'O portfólio que este cofre segue publicou uma nova versão.',
    drift: 'Uma parte tinha se afastado demais da fatia planejada.',
    liquidity_breach:
      'Uma parte difícil de vender foi reduzida, para que o caixa possa ser alcançado a tempo.',
    none: 'Não há motivo guardado para este passo.',
    version: 'Ele adotou uma nova versão do portfólio que o cofre segue.',
  },
  noTrade: 'Este passo não negociou nada.',
  noTx: 'Não há transação guardada para este passo.',
  trade: {
    bought: (asset: string, cash: string) => `Comprou ${asset} com caixa (${cash}).`,
    sold: (asset: string, cash: string) => `Vendeu ${asset} por caixa (${cash}).`,
    triedBuy: (asset: string, cash: string) => `Tentou comprar ${asset} com caixa (${cash}).`,
    triedSell: (asset: string, cash: string) => `Tentou vender ${asset} por caixa (${cash}).`,
    swapped: (sold: string, bought: string) => `Vendeu ${sold} por ${bought}.`,
    triedSwap: (sold: string, bought: string) => `Tentou vender ${sold} por ${bought}.`,
    tokens: (amount: string, token: string) => `${amount} ${token}`,
    paid: 'Pago',
    soldAmount: 'Vendido',
    amount: 'Quantia do passo',
    heldBefore: 'No cofre antes',
    heldAfter: 'No cofre depois',
    noUnits: (token: string) =>
      `Este app não tem as unidades de ${token}, então as quantias de antes e depois não são mostradas.`,
    quoted: 'Custo cotado',
    bps: (cost: string) => `${cost} bps`,
    quoteZero: 'Uma cotação pode aparecer como zero onde não havia preço de referência.',
    before: 'Antes',
    after: 'Depois',
    over: (by: string) => `${by} acima da fatia planejada`,
    under: (by: string) => `${by} abaixo da fatia planejada`,
    at: 'na fatia planejada',
    read: (when: string) => `lido em ${when}`,
  },
  quoteNote:
    'O custo cotado é o da cotação com que este passo foi montado. Não é o que a operação pagou.',
  derived: 'Deduzido de duas leituras do cofre. Não é um registro da operação.',
  noExplorer: 'na nossa rede de exemplo, então nenhum explorador a mostra',
  note: {
    heading: 'O que esta lista ainda não sabe dizer',
    items: [
      'Quando um passo seu foi confirmado na rede. A hora mostrada é a de quando o passo foi montado.',
      'Quanto uma operação pagou. O custo mostrado é o de uma cotação, em pontos-base: 100 bps são 1%.',
      'As operações do nosso operador, uma por uma. Cada uma é deduzida de duas leituras de um cofre nos últimos trinta dias, então não tem transação, cotação nem motivo, e várias operações de um ativo entre duas leituras aparecem como uma só.',
      'Uma versão que nosso operador adotou para você, e seus próprios rebalanceamentos, saques e mudanças de configuração: essas ordens ainda não existem.',
    ],
    more: 'Leia como estas páginas funcionam e o que mais não dizem',
  },
};
