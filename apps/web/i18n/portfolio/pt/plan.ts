import type { Plan } from '../en/plan';

// A plan's own page in Brazilian Portuguese: the same keys as en/plan.ts. It keeps the words the
// section already chose: "retrato" (snapshot), "margem" (band), "faixa" (tier), "fatia" (share),
// "nosso operador" (our keeper). New here, and proposals too: "ponto-base" (basis point), "posição"
// (holding), "operação" (trade), "sinalizar" (to flag), "período" (window). Rodrigo owns this wording.

export const plan: Plan = {
  label: 'Um plano',
  title: 'Este plano ao longo do tempo.',
  back: 'Todos os seus planos',
  notFound: 'Não há plano seu para mostrar neste endereço.',
  chainOut: (chain: string) =>
    `Seus planos na ${chain} não puderam ser lidos, então não consigo mostrar este agora.`,
  head: {
    label: 'Como este plano está',
  },
  unread:
    'Quando este cofre for lido, o valor dele ao longo do tempo, as partes, quanto custaria sair e onde está o risco aparecem aqui. Lemos cada cofre mais ou menos a cada dez minutos.',

  history: {
    heading: 'Valor ao longo do tempo',
    lead: 'Quanto este cofre valia em cada retrato que guardamos. A linha é medida, não projetada.',
    reading: 'Lendo o histórico deste cofre…',
    window: {
      label: 'Período',
      day: '24 horas',
      week: '7 dias',
      month: '30 dias',
      quarter: '90 dias',
    },
    plot: (from: string, to: string) =>
      `O valor deste cofre de ${from} a ${to}, um ponto para cada retrato guardado.`,
    hint: 'Aponte para a figura, toque nela ou use as setas do teclado para ler um ponto.',
    newest: 'Retrato mais recente',
    legend: {
      label: 'O que a figura desenha',
      value: 'Valor em cada retrato, medido',
      deposit: 'Um depósito seu',
    },
    none: (when: string) =>
      `Nenhum retrato deste cofre cai neste período: o mais recente é de ${when}. Tiramos um retrato mais ou menos a cada dez minutos.`,
    one: 'Só um retrato cai neste período até agora. Uma linha precisa de dois, e tiramos um retrato mais ou menos a cada dez minutos.',
    oneAt: (when: string) => `Em ${when}:`,
    deposits: {
      label: 'Seus depósitos neste período',
      name: (n: number) => `Depósito ${n}`,
      recorded: (when: string) => `registrado em ${when}`,
      note: 'Um depósito é marcado na hora em que nosso servidor soube que ele foi confirmado, o que pode ser um pouco depois de ele chegar à rede.',
      outside: (n: number) =>
        n === 1
          ? '1 depósito seu fica fora deste período.'
          : `${n} depósitos seus ficam fora deste período.`,
    },
  },

  parts: {
    heading: 'Cada parte comparada ao planejado',
    caption: 'O que este cofre tinha no retrato mais recente, comparado ao plano',
    band: (band: string) =>
      `Uma parte pode ficar a até ${band} da fatia planejada antes de contar como fora da margem. O caixa só conta quando está acima da fatia dele.`,
    unweighed:
      'Uma parte que está no cofre não tem preço, então cada fatia é uma fatia do que pôde ser avaliado, e nada é comparado à margem.',
    status: 'Margem',
    outside: 'Fora da margem',
    noPrice: 'Sem preço',
    noneHeld: 'Nada no cofre',
    notWeighed: 'Não pesada',
    priceNotKept: 'Preço não guardado',
    empty: 'Este cofre não guarda nada, então não há partes para mostrar.',
  },

  exit: {
    heading: 'Quanto custaria sair',
    lead: 'Cada custo é a medida da Bearing para vender, sozinha, toda a posição deste cofre em um ativo, no tamanho mostrado. Não é o custo de vender tudo de uma vez, que estes números não sabem dizer. Um ponto-base é um centésimo de um por cento.',
    reading: 'Lendo quanto custaria sair…',
    holding: 'Posição',
    costLabel: 'Vendê-la sozinha',
    cost: (bps: number, shown: string) =>
      bps === 1 ? `${shown} ponto-base` : `${shown} pontos-base`,
    beyond: 'Esta posição é maior que a maior venda medida, então nenhum custo é informado.',
    notDated: 'Um custo foi medido, mas a medição não tem data, então nenhum número é mostrado.',
    noSource: 'Um custo foi medido, mas veio sem fonte, então nenhum número é mostrado.',
    tier: (tier: string) =>
      `Não medido. A faixa dele, ${tier}, é só um teto para a fatia dele em um plano e não informa custo.`,
    notMeasured: 'Não medido, então nenhum custo é informado.',
    none: 'Nada do que este cofre tem precisaria ser vendido: ele tem só caixa, ou nada com preço.',
    nothing: 'Este cofre não tem nada com valor, então não há custo de venda a mostrar.',
    unvalued: (n: number, names: string) =>
      n === 1
        ? `${names} está no cofre sem preço, então não entra em nenhum destes números.`
        : `${names} estão no cofre sem preço, então não entram em nenhum destes números.`,
  },

  risk: {
    heading: 'Onde está o risco',
    lead: 'As posições deste cofre por quem as emite e por tipo de ativo, e o que os números sinalizam.',
    reading: 'Lendo onde está o risco…',
    of: 'Fatias do que este cofre tinha com valor:',
    nothing: 'Este cofre não tem nada com valor, então não há divisão para mostrar.',
    standIn:
      'Na nossa rede de exemplo todo emissor é um substituto, então esta divisão não diz nada sobre emissores reais.',
    flags: {
      heading: 'O que estes números sinalizam',
      none: 'Nada é sinalizado para este cofre.',
      unknown: (name: string) => `Mais um sinal, para o qual ainda não tenho uma frase: ${name}.`,
      known: {
        issuer_concentration: 'Mais da metade deste cofre está com um só emissor.',
        asset_not_on_shelf:
          'Uma posição não está na nossa lista de ativos, então não pôde ser classificada.',
        exit_not_measured:
          'Nenhuma posição que precisaria ser vendida tem custo de venda medido ainda.',
        exit_partly_measured:
          'Só algumas das posições que precisariam ser vendidas têm custo de venda medido.',
        exit_beyond_measured_size:
          'Uma posição é maior que a maior venda medida para ela, então nenhum custo é informado para ela.',
        exit_capacity_short:
          'Uma posição é maior do que se vende por 1% ou menos no pior horário medido.',
        exit_quote_missing: 'Ainda não há cotação guardada para vender uma posição.',
        exit_quote_partial: 'Só algumas posições têm cotação guardada para vendê-las.',
        exit_quote_stale: 'Uma cotação para vender uma posição tem mais de três horas.',
        exit_quote_far_from_size:
          'Uma cotação para vender uma posição é de um tamanho longe do que está aqui.',
      },
      quoted: (kind: string) =>
        `Uma cotação por trás destes números vem de ${kind}, não de um mercado ao vivo.`,
      measured: (kind: string) =>
        `Um custo medido por trás destes números vem de ${kind}, não de um mercado ao vivo.`,
      kinds: {
        mock: 'dados de exemplo',
        sandbox: 'uma rede de teste',
        fixture: 'dados fixos',
        prior_dataset: 'dados anteriores',
      },
      otherKind: 'uma fonte que não é ao vivo',
    },
  },

  trades: {
    heading: 'Últimas operações',
    lead: 'Os passos mais recentes que negociaram para este cofre ou mudaram a versão que ele segue: os seus, e os rebalanceamentos do nosso operador.',
    reading: 'Lendo as últimas operações…',
    none: 'Ainda não há operação deste cofre guardada.',
    all: 'Ver todas as operações e rebalanceamentos',
    by: {
      owner: 'Você',
      keeper: 'Nosso operador',
    },
    trade: (sell: string, buy: string) => `${sell} → ${buy}`,
    version: 'Uma nova versão do portfólio que ele segue',
    noTrade: 'Um passo sem operação',
    built: (when: string) => `montado em ${when}`,
    traded: (when: string) => `negociado em ${when}`,
    derived: 'deduzido de dois retratos do cofre',
    more: (n: number) =>
      n === 1
        ? '1 passo mais antigo não aparece aqui.'
        : `${n} passos mais antigos não aparecem aqui.`,
    cut: (n: number) =>
      `Só os ${n} passos mais recentes dos seus cofres são lidos aqui, então um mais antigo pode faltar.`,
  },

  activity: {
    note: 'Abaixo estão os passos das suas próprias ordens para este cofre que chegaram à rede, como este app os guardou. As operações do nosso operador não estão entre eles.',
    none: 'Nenhum passo de uma ordem sua para este cofre chegou à rede ainda.',
  },
};
