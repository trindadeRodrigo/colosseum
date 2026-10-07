import type { Exposure } from '../en/exposure';

// The exposure page in Brazilian Portuguese: the same keys as en/exposure.ts. The words follow the
// methodology's ("custo de venda", "faixa", "emissor", "substituto", "rede de exemplo", "posição");
// "pelo que cada ativo acompanha", "teto" and "pontos-base" are proposals: Rodrigo owns this wording.

export const exposure: Exposure = {
  label: 'Exposição',
  title: 'O que seus planos somam.',
  lead: 'O que seus cofres têm, somado pelo que cada ativo acompanha e por quem o emite, e quanto custaria vender cada posição. Nada aqui assina ou move coisa alguma.',
  notes: {
    chains: 'Cada rede é somada à parte. As redes nunca são somadas entre si.',
    vaults: 'Um cofre conta depois de lido. Um que ainda não foi lido não soma nada.',
    exit: 'Um custo de venda é o de um ativo vendido sozinho, no tamanho de toda a sua posição nele naquela rede. Não é o custo de vender tudo de uma vez.',
    bps: 'Os custos estão em pontos-base: 100 bps são 1%.',
  },
  empty:
    'Seus cofres ainda não têm nada. O que eles têm aparece aqui quando um cofre com algo dentro for lido.',
  chain: {
    total: (vaults: number) =>
      vaults === 1 ? 'O 1 cofre que foi lido tem' : `Os ${vaults} cofres que foram lidos têm`,
    oldest: (when: string) =>
      `A leitura mais antiga por trás destas somas foi feita em ${when}. As somas não são mais recentes do que isso.`,
    undated: 'Estas somas vieram sem a hora em que foram lidas, então nenhum número é mostrado.',
    noPriced: 'Nada do que está aqui tem preço, então não há soma para mostrar.',
    noneRead: (chain: string) =>
      `Nenhum cofre seu na ${chain} foi lido ainda, então não há o que somar.`,
    none: (vaults: number, chain: string) =>
      vaults === 1
        ? `Seu cofre na ${chain} ainda não tem nada.`
        : `Seus ${vaults} cofres na ${chain} ainda não têm nada.`,
  },
  shares: {
    byUnderlying: 'Pelo que cada ativo acompanha',
    byIssuer: 'Por quem emite',
    standIns:
      'Na nossa rede de exemplo todo emissor e toda faixa são substitutos, então não há divisão por emissor para mostrar.',
    testNetwork: 'Tokens da própria rede de teste',
  },
  exit: {
    heading: 'Quanto custaria vender',
    holding: 'Sua posição',
    measured: 'Custo medido de vender tudo',
    bps: (cost: string) => `${cost} bps`,
    undated: 'Foi medido, mas a medição veio sem data, então nenhum custo é mostrado.',
    unsourced: 'Foi medido, mas a medição veio sem a fonte, então nenhum custo é mostrado.',
    beyond:
      'Sua posição é maior do que a maior venda que foi medida, então nenhum custo é informado.',
    tier: (tier: string) =>
      `Não medido. A faixa dele, ${tier}, é só um teto para a fatia dele em um plano, e não informa custo.`,
    unmeasured: 'Não medido, então nenhum custo é mostrado.',
  },
  flags: {
    heading: 'O que saber sobre estas posições',
    unnamed: 'Uma nota para a qual ainda não temos palavras:',
    say: {
      issuer_concentration: 'Mais da metade do que você tem aqui está com um só emissor.',
      asset_not_on_shelf:
        'Uma posição não está na lista de ativos, então não pôde ser classificada.',
      exit_not_measured: 'Nenhuma posição aqui tem custo de venda medido ainda.',
      exit_partly_measured: 'Só parte das posições aqui tem custo de venda medido.',
      exit_beyond_measured_size:
        'Uma posição aqui é maior do que a maior venda que foi medida, então vendê-la pode custar mais.',
      exit_capacity_short:
        'Uma posição aqui é maior do que o que dá para vender por 1% ou menos na pior hora medida.',
      exit_quote_missing:
        'Não há cotação recente para vender estas posições, então só os custos medidos são mostrados.',
      exit_quote_partial: 'Só parte destas posições tem uma cotação recente de venda.',
      exit_quote_stale: 'Uma cotação de venda de uma posição aqui tem mais de três horas.',
      exit_quote_far_from_size:
        'Uma cotação de venda de uma posição aqui é para um tamanho bem diferente do seu, então pode mostrar um custo menor que o real.',
      quoted_provenance: 'O custo de venda cotado se apoia em números que não são reais.',
      measured_provenance: 'O custo de venda medido se apoia em números que não são reais.',
    },
  },
  unvalued: {
    heading: 'Posições sem preço',
    note: 'Estas não têm preço, ou não estão na lista de ativos, então não entram em nenhuma soma acima.',
    vault: 'no cofre',
    open: (address: string) => `Ver o plano do cofre ${address} ao longo do tempo`,
  },
  more: 'Leia como estes números são feitos e o que ainda não dizem',
};
