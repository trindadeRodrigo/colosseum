import type { BearingDictionary } from './en';

// Bearing's analytics in Brazilian Portuguese: the same keys as en.ts.

export const bearingPt: BearingDictionary = {
  head: 'Bearing · análises',
  notAdvice: 'Aviso legal',
  menu: {
    region: 'Páginas de análises',
    nav: 'Análises',
    show: 'Mostrar menu',
    hide: 'Esconder menu',
  },
  pages: {
    stocks: {
      label: 'Ações',
      lede: 'Quanto custa sair de uma ação, e quanto os pools conseguem absorver.',
    },
    commodities: {
      label: 'Commodities',
      lede: 'Quanto custa sair do ouro, e quanto os pools conseguem absorver.',
    },
    stablecoins: {
      label: 'Stablecoins',
      lede: 'Quanto de cada stablecoin está emprestado, e quanto você poderia sacar agora.',
    },
    lending: {
      label: 'Empréstimos',
      lede: 'Se a garantia tivesse de ser vendida hoje, quanto dela os pools absorveriam.',
    },
    simulation: {
      label: 'Simulação',
      lede: 'Venda uma posição agora: o que você perderia, e a melhor saída.',
    },
    methodology: {
      label: 'Metodologia',
      lede: 'Como cada número destas páginas é medido, e o que ele não é.',
    },
  },
  banner: {
    loading: 'Lendo a API de risco…',
    live: (time: string) => `Ao vivo dos coletores, até ${time}.`,
    unknownTime: 'uma hora desconhecida',
    now: (regime: string, et: string) => `agora: ${regime} (${et})`,
    stale: (when: string, age: string) =>
      `A leitura mais recente dos coletores é de ${when}, há ${age}.`,
    unknownAge: 'tempo desconhecido',
    noReading: 'Os coletores ainda não têm leitura.',
    staleAll: 'Todo número está defasado: medido, apenas antigo. A idade de cada um está ao lado.',
    down: (api: string) => `A API de risco em ${api} não respondeu.`,
    downAll: 'Cada número desta página espera por ela; nenhum é inventado no lugar.',
  },
  chain: {
    label: 'Rede',
    pageNotCollected: (chain: string) =>
      `Ainda não coletado na ${chain}: por enquanto o Bearing mede esta página só na Solana.`,
    sideBySide: {
      title: 'As redes lado a lado',
      note: 'Cada rede como o Bearing a mede agora. A capacidade de saída é lida no horário da semana de agora.',
      caption: 'Ativos acompanhados, TVL dos pools, capacidade de saída e volume em 24 h por rede',
      chain: 'Rede',
      assets: 'Ativos acompanhados',
      tvl: 'TVL dos pools',
      capacity: 'Capacidade de saída com custo ≤ 1%',
      volume: 'Volume 24 h',
    },
  },
  regimes: {
    us_market_hours: 'pregão',
    us_offhours_weekday: 'fora do pregão',
    weekend: 'fim de semana',
    us_holiday: 'feriado',
  },
  reasons: {
    no_samples_in_regime: 'ainda sem amostras neste regime',
    insufficient_samples: 'poucas amostras para ajustar',
    not_a_number: 'o valor guardado não pôde ser usado',
    beyond_measured_size: 'além do maior tamanho medido',
    no_reference_price: 'sem preço de referência',
    no_external_source: 'sem fonte externa para isto',
    chain_not_covered: 'rede não coberta',
    not_collected: 'ainda não coletado',
    not_imported: 'ainda não importado',
    not_followed: 'não acompanhado',
    before_routed_curves: 'de antes das curvas roteadas',
    gate_open: 'aguardando uma decisão em aberto',
    not_applicable: 'não se aplica aqui',
    not_served: 'a API não fornece isto',
    api_error: 'a API não respondeu',
    nothing_selected: 'nada selecionado',
    no_price_source: 'sem fonte de preço',
  },
  filter: {
    all: (n: number) => `Todos (${n})`,
    none: 'Nenhum',
    some: (n: number, of: number) => `${n} de ${of}`,
    selectAll: 'Todos',
    selectNone: 'Nenhum',
  },
  /** Beside a figure made of parts when some have no figure: it is of the measured ones only. */
  partial: (n: number) => `dos ${n} medidos`,
  pie: {
    /** Under the legend: the pools with no figure, which get no slice. */
    missing: (n: number) =>
      n === 1
        ? '1 pool não tem número e não é desenhado.'
        : `${n} pools não têm número e não são desenhados.`,
    others: (n: number) => `${n} ${n === 1 ? 'outro pool' : 'outros pools'}`,
    point: 'Aponte para uma fatia ou uma linha para ver o valor.',
  },
  chart: {
    range: 'Período',
    metric: 'Métrica',
    noData: 'Sem dados',
    noValue: 'sem valor',
    fewSamples: 'poucas amostras',
    zoom: 'Zoom',
    zoomIn: 'Aproximar',
    zoomOut: 'Afastar',
    poolPrice: 'Preço do pool',
    below: (quote: string) => `${quote} (abaixo do preço)`,
    above: (asset: string) => `${asset} (acima do preço)`,
    noUsd: 'sem preço em dólar',
    held: (token: string) => `em ${token}`,
    sourceOf: (what: string) => `o ${what}`,
  },
  heat: {
    head: (asset: string, size: string) =>
      `${asset} · custo de venda de ${size}, por hora da semana`,
    thinnest: (when: string) => `mais raso: ${when}`,
    note: 'No fundo escuro, células mais claras custam menos para sair; no papel, as mais escuras custam menos.',
    what: (size: string) => `para vender ${size}`,
    aria: (asset: string, size: string) =>
      `Custo mediano de venda de ${asset} em ${size} por hora da semana, horário de Nova York`,
    meta: (n: string, hours: number, zone: string, at: string) =>
      `USD · n=${n} · ${hours} de 168 horas com amostra · ${zone} · método risk-0.3 · em ${at}`,
    reading: 'Lendo as horas…',
    table: 'Ver como tabela',
    deepFirst: 'Dia mais profundo primeiro',
    least: 'menos profundidade',
    most: 'mais profundidade',
    legend: (n: number) => `– sem amostra · faixas são quintis destas ${n} horas`,
    move: 'Percorra as horas com as setas do teclado.',
    noSample: 'sem amostra',
    day: 'Dia',
    days: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'],
  },
  dex: {
    reading: 'Lendo os pools…',
    assets: 'Ativos',
    pools: 'Pools',
    poolsSub: (n: string) => `${n} pools`,
    summary: (assets: number, pools: number, regime: string) =>
      `${assets} ${assets === 1 ? 'ativo' : 'ativos'} · ${pools} ${pools === 1 ? 'pool' : 'pools'} · agora ${regime}`,
    metrics: { capacity: 'Capacidade de saída', tvl: 'TVL no tempo', liquidity: 'Liquidez' },
    kpi: {
      tvl: 'TVL dos pools',
      tvlNote: 'pools selecionados, lido no registro',
      pools: 'Pools',
      poolsNote: (n: string) => `de ${n} nos ativos selecionados`,
      capacity: 'Capacidade de saída agora',
      capacityNote: (regime: string) => `venda com custo ≤ 1%, ${regime}`,
      volume: 'Volume 24 h',
      volumeNote: (to: string) => `até ${to}, o histórico de swaps mais recente`,
      volumeDexNote:
        'Número da DexScreener: o histórico de swaps do Bearing ainda não é coletado aqui.',
      lp: 'Fatia dos 3 maiores LPs',
      lpNote: 'maior pool, por posição',
    },
    pie: { title: 'TVL por pool', note: 'lido quando cada pool foi registrado' },
    table: {
      title: 'Ativos',
      note: 'Capacidade é a maior venda que custa no máximo 1%, por horário da semana. Capacidade de saída é esse número hora a hora. O filtro de pools restringe o TVL, o gráfico de pizza, a contagem de pools e o gráfico de liquidez; a capacidade é roteada por todos os pools de um ativo, então não muda com ele. Abra um ativo para simular a venda dele.',
      caption: 'Ativos com pools, capacidade, volume e fatia dos LPs',
      asset: 'Ativo',
      pools: 'Pools',
      poolsOf: (n: string) => `de ${n}`,
      capacity: {
        us_market_hours: 'Capacidade, pregão',
        us_offhours_weekday: 'Capacidade, fora do pregão',
        weekend: 'Capacidade, fim de semana',
        us_holiday: 'Capacidade, feriado',
      },
      volume: 'Volume 24 h',
      lp: 'Fatia dos 3 maiores LPs',
      spark: 'Capacidade de saída, 30 d',
    },
    capacity: {
      title: 'Capacidade de saída com custo ≤ 1%',
      note: (from: string) =>
        `lados de venda e compra, somados nos ativos selecionados, um ponto por hora UTC desde ${from}, quando as curvas roteadas começaram`,
      firstCurve: 'a primeira curva roteada',
      sell: 'venda (para sair)',
      buy: 'compra (para entrar)',
      aria: 'Capacidade de saída e de compra ao longo do tempo para os ativos selecionados',
      src: 'gráfico de capacidade',
      partial: (k: number, n: number) => `(${k} de ${n} ativos)`,
    },
    tvl: {
      title: 'TVL no tempo',
      none: 'o coletor registra o valor do pool hora a hora só para os pools de liquidez concentrada que formam os 80% maiores do TVL do registro, e nenhum dos pools selecionados é um deles. O TVL de hoje da seleção está nos contadores; a capacidade de saída no tempo é medida para todo ativo.',
      reading: (n: number) => `Lendo ${n} ${n === 1 ? 'pool registrado' : 'pools registrados'}…`,
      recorded: 'TVL no tempo, pools registrados',
      note: (n: number, of: number, share: string | null) =>
        `${n} de ${of} pools selecionados são registrados de hora em hora${share ? `, com ${share} do TVL da seleção` : ''}; o valor dos tokens que a liquidez deles guarda, sem contar taxas não coletadas. Um pool sem registro numa hora mantém seu último valor por até 6 h. Os registros começaram em 2026-10-01.`,
      value: 'valor do pool',
      valueLegend: 'valor do pool (TVL)',
      held: 'parte no ativo',
      heldLegend: 'parte guardada no ativo',
      aria: 'Valor guardado pelos pools registrados ao longo do tempo',
      src: 'gráfico de TVL',
      partial: (k: number, n: number) => `(${k} de ${n} pools)`,
    },
    liquidity: {
      title: 'Liquidez por faixa de preço',
      none: 'nenhum dos pools selecionados é de liquidez concentrada; um pool de produto constante espalha sua liquidez por todos os preços.',
      reading: 'Lendo o pool…',
      both: 'Liquidez por faixa de preço, os dois lados',
      failed: (error: string) =>
        `${error}. O coletor registra só os pools que formam os 80% maiores do TVL do registro; escolha um sem “não registrado”, ou espere pela leitura ao vivo.`,
      recordedAt: (at: string) => `o registro horário mais recente do coletor, ${at}`,
      liveAt: (at: string) => `lido ao vivo às ${at} UTC`,
      note: (when: string) =>
        `guardada a até ±30% do preço, a partir de ${when}; o ativo espera acima do preço (vendido conforme sobe), a moeda de cotação abaixo (usada para comprar conforme cai); + e − para zoom`,
      aria: (pool: string) =>
        `Liquidez do pool ${pool} por faixa de preço em torno do preço do pool`,
      src: 'gráfico de distribuição',
      pool: 'Pool',
      option: (label: string, tvl: string, recorded: boolean) =>
        `${label} · TVL ${tvl}${recorded ? '' : ' · não registrado'}`,
      quoteNotNamed: 'cotação sem nome',
      asset: 'ativo',
      quote: 'cotação',
    },
  },
  lending: {
    reading: 'Lendo os pools de empréstimo…',
    pricing: 'Precificando a garantia…',
    pools: 'Pools de empréstimo',
    collateral: 'Garantia',
    summary: (n: number, regime: string) => `${n} ${n === 1 ? 'pool' : 'pools'} · agora ${regime}`,
    tolerance: 'Tolerância',
    toleranceTitle:
      'Uma venda conta como coberta quando custa no máximo isto, com taxas e impacto de preço',
    toleranceError: 'Entre 0,1% e 10%',
    metrics: { covered: 'Coberto', tvl: 'TVL no tempo', liquidity: 'Liquidez' },
    kpi: {
      supplied: 'Depositado',
      borrowed: 'Emprestado',
      collateral: 'Garantia depositada',
      collateralNote: 'ativos selecionados',
      covered: 'Coberto agora',
      coveredNote: (tol: string, regime: string) => `vendido com custo ≤ ${tol}, ${regime}`,
      largest: 'Maior venda dentro da tolerância',
      largestNote: (tol: string) => `tolerância de ${tol}`,
      loss: 'Perda se tudo for vendido',
      lossNote: (share: string) => `${share} da garantia`,
    },
    pie: {
      title: 'Depositado por pool',
      note: 'Kamino: o token depositado; cofres da Jupiter Lend: a garantia depositada',
    },
    covered: {
      title: (tol: string) => `Coberto e não coberto, tolerância de ${tol}`,
      note: (from: string) =>
        `a garantia de hoje contra a capacidade de saída de cada hora, como fatia de 100%; horas em que algum ativo de garantia não tem medição ficam de fora. O contador acima lê a curva ajustada sobre toda a semana; este gráfico lê o retrato de cada hora, então os dois podem diferir. As curvas roteadas por hora começaram em ${from}.`,
      notCovered: 'não coberto',
      covered: 'coberto',
      coveredLegend: (tol: string) => `coberto: vendido com custo ≤ ${tol}`,
      notCoveredLegend: 'não coberto: a venda custaria mais',
      aria: (tol: string) =>
        `Fatia da garantia coberta pela profundidade dos pools com custo de ${tol}, ao longo do tempo`,
      src: 'gráfico de cobertura',
    },
    supplied: {
      title: 'Depositado e emprestado',
      note: 'somado nos pools selecionados: de hora em hora nos últimos 7 dias, a última leitura do dia antes disso',
      supplied: 'depositado',
      borrowed: 'emprestado',
      aria: 'Depositado e emprestado ao longo do tempo',
      src: 'gráfico de depósitos',
      partial: (k: number, n: number) => `(${k} de ${n} pools)`,
    },
    avail: {
      title: 'Disponível para saque',
      note: (more: string) =>
        `o dinheiro que um credor poderia sacar, e a fatia emprestada abaixo; ${more}`,
      jupiter:
        'um cofre da Jupiter Lend não tem número aqui (o token emprestado fica numa camada de liquidez compartilhada)',
      available: 'disponível',
      lent: 'fatia emprestada',
      aria: 'Disponível para saque e fatia emprestada ao longo do tempo',
      src: 'gráfico de liquidez',
    },
    table: {
      title: 'Pools de empréstimo',
      note: (tol: string, regime: string) =>
        `Coberto é a fatia da garantia de um pool que os pools de swap poderiam comprar com custo de no máximo ${tol} no horário atual da semana (${regime}); o resto seria vendido com perda maior. A perda se tudo for vendido é a venda roteada de cada ativo de garantia no tamanho inteiro, de uma vez. Numa linha, cada pool de empréstimo conta sozinho; nos contadores e no gráfico, cada posição numa ação é somada primeiro e vendida nos pools dessa ação uma vez, já que usam a mesma profundidade. A Kamino informa a garantia por mercado, então as reservas de um mercado mostram a mesma garantia; os contadores e o gráfico a contam uma vez.`,
      caption: 'Pools de empréstimo com a cobertura da garantia',
      pool: 'Pool',
      explorer: (pool: string) => `Ver ${pool} no Solscan`,
      supplied: 'Depositado',
      available: 'Disponível agora',
      jupiterAvailable:
        'o token emprestado do cofre fica na camada de liquidez compartilhada da Jupiter Lend',
      lent: 'Fatia emprestada',
      top1: 'Fatia do maior credor',
      collateral: 'Garantia',
      assets: (n: number) => `${n} ativos`,
      covered: 'Coberto',
      largest: 'Maior venda dentro da tolerância',
      loss: 'Perda se tudo for vendido',
      lossShare: (share: string) => `${share} dela`,
      spark: 'Coberto, 30 d',
    },
    market: (id: string) => `mercado ${id}`,
  },
  stable: {
    reading: 'Lendo as reservas de stablecoins…',
    coins: 'Stablecoins',
    reserves: 'Reservas',
    summary: (n: number) => `${n} ${n === 1 ? 'reserva' : 'reservas'}`,
    metrics: { tvl: 'TVL no tempo', liquidity: 'Liquidez' },
    kpi: {
      supplied: 'Depositado',
      borrowed: 'Emprestado',
      available: 'Disponível agora',
      availableNote: 'o que os credores poderiam sacar',
      lent: 'Fatia emprestada',
      reserves: 'Reservas',
      reservesNote: 'reservas de empréstimo da Kamino',
    },
    pie: 'Depositado por reserva',
    supplied: {
      title: 'Depositado e emprestado',
      note: 'de hora em hora nos últimos 7 dias, a última leitura do dia antes disso',
      aria: 'Stablecoins depositadas e emprestadas ao longo do tempo',
    },
    availNote: 'somado nas reservas selecionadas',
    table: {
      title: 'Stablecoins',
      note: 'Medidas onde os coletores as leem hoje: as reservas de empréstimo da Kamino que as emprestam. Um credor sai sacando, então “disponível agora” toma o lugar da capacidade de saída. Os pools de swap de stablecoins e as que rendem (USDY, syrupUSDC) passam a ser medidos quando o item 17 entrar.',
      caption: 'Stablecoins por reserva de empréstimo',
      asset: 'Ativo',
      reserves: 'Reservas',
      supplied: 'Depositado',
      available: 'Disponível agora',
      lent: 'Fatia emprestada',
      volume: 'Volume 24 h',
      top1: 'Fatia do maior credor',
      spark: 'Disponível, 30 d',
      largest: 'maior reserva',
    },
  },
  sim: {
    reading: 'Lendo os ativos…',
    asset: 'Ativo para vender',
    amount: 'Valor, em dólares',
    simulate: 'Simular',
    amountError: 'Digite um valor entre US$ 100 e US$ 1.000.000.000, por exemplo 250000 ou 250k.',
    pricing: (n: string, id: string) => `Precificando ${n} de ${id}…`,
    kpi: {
      sale: 'Venda',
      saleNote: (id: string) => `${id}, o que você digitou`,
      now: 'Horário da semana agora',
      capacity: 'Capacidade de saída agora',
      capacityNote: 'venda com custo ≤ 1%',
      loss: 'Perda no melhor caminho',
      lossNote: (share: string) => `${share} da venda`,
    },
    verdict: {
      none: (n: string, id: string, why: string) =>
        `Nenhuma rota medida dá preço a ${n} de ${id} agora: ${why}. A simulação nunca estende uma curva além do que foi medido.`,
      best: (n: string, id: string, path: string, atLeast: boolean, loss: string, share: string) =>
        `Melhor caminho para ${n} de ${id} agora: ${path}. Ele perde ${atLeast ? 'pelo menos ' : ''}${loss} (${share})`,
      against: (loss: string) => `, contra ${loss} vendendo tudo agora.`,
      end: '.',
      waits: ' Esperar traz um risco de preço que esta perda não conta.',
    },
    paths: {
      now: {
        name: 'Vender agora nos pools',
        how: 'uma venda roteada, dividida entre os pools em dólar do ativo',
        when: (regime: string) => `agora · ${regime}`,
      },
      open: {
        name: 'Esperar o pregão',
        how: 'a mesma venda roteada na próxima abertura dos EUA; o preço pode mudar enquanto você espera',
        when: (wait: string, at: string) => `em ${wait} · ${at}`,
        notFound: 'próxima abertura não encontrada',
      },
      split: {
        name: (k: number) => `Dividir em ${k} vendas por hora`,
        how: (k: number, each: string, minutes: string | null) =>
          `${k} vendas de ${each}, cada uma dentro da capacidade de 1%, uma por hora; supõe que os pools se recompõem entre as vendas${
            minutes
              ? ` (depois de negócios grandes eles recuperaram 90% da profundidade numa mediana de ${minutes} min)`
              : ''
          }`,
        when: (k: number, regime: string) => `em ${k} h · ${regime}`,
      },
      issuer: {
        name: 'Resgatar com o emissor',
        how: (issuer: string, status: string, settles: string) =>
          `${issuer}: ${status}; ${settles}; exige KYC com o emissor`,
        theIssuer: 'o emissor',
        noStatus: 'situação não informada',
        settles: (days: string) => `liquida em ${days} dias`,
        noSettle: 'prazo de liquidação não informado',
        when: (hours: number) => `${hours} horas abertas nos próximos 7 dias`,
        never: 'nenhuma janela aberta nos próximos 7 dias',
      },
    },
    wait: {
      min: (n: string) => `${n} min`,
      h: (n: string) => `${n} h`,
      days: (n: string) => `${n} dias`,
    },
    flowTitle: 'Caminhos, como fluxo',
    pathsTitle: 'Caminhos',
    pathsCaption: 'Formas de vender, com custo e perda',
    head: { path: 'Caminho', how: 'Como', when: 'Quando', cost: 'Custo', loss: 'Perda' },
    best: 'melhor',
    capacityNotCost: 'capacidade, não custo',
    neverChosen: 'nunca escolhido no lugar de uma rota medida',
    pathsNote:
      'O melhor caminho é o medido com a menor perda; num empate, o que não espera. O resgate com o emissor depende dos termos publicados pelo emissor, uma premissa de cenário, então aparece mas nunca é escolhido no lugar de uma rota medida.',
    paysTitle: 'O que o melhor caminho paga',
    parts: {
      poolFee: 'taxa do pool',
      transferFee: 'taxa de transferência',
      impact: 'impacto de preço',
      basis: 'base contra a referência',
      platformFee: 'taxa da plataforma',
      networkFee: 'taxa de rede',
    },
    byRegimeTitle: 'A mesma venda por horário da semana',
    byRegimeCaption: 'Custo por horário da semana',
    regime: 'Horário da semana',
    now: 'agora',
  },
  flow: {
    region: 'Os caminhos como fluxo, rola para o lado',
    aria: (n: string, id: string) =>
      `Fluxo de uma venda de ${n} de ${id} por cada caminho, seus pools e o token de pagamento, até os dólares recebidos`,
    columns: ['Posição', 'Caminho', 'Pools em que a venda se divide', 'Pago em', 'Você recebe'],
    position: (regime: string) => `sua posição, ${regime}`,
    received: 'Dólares recebidos',
    receivedSub: 'USDC ou USD',
    solHop: 'SOL, trocado por USDC',
    solHopSub: 'um segundo salto',
    usdOut: 'USDC / USDT',
    usdOutSub: 'pago pelo pool',
    issuer: 'Resgate com o emissor',
    issuerSub: 'liquida em T+5, KYC',
    samePools: 'Os mesmos pools',
    routed: 'roteado',
    noOpenSplit: 'ainda sem divisão simulada no pregão',
    noSplit: 'sem divisão para este caminho',
    assumption: 'premissa',
    notMeasured: 'não medido',
    cost: (c: string) => `custo ${c}`,
    noCost: 'custo não informado',
    ofIt: (share: string) => `${share} dela`,
    best: 'melhor',
    note: (notes: string) =>
      `Cada cor é um caminho; são alternativas, não uma venda só. O melhor caminho aparece mais forte; o resgate com o emissor é tracejado porque depende dos termos do emissor. A espessura da linha segue a fatia de cada pool na venda. ${notes} Valores recebidos e perdas são os da tabela, o custo ajustado no tamanho exato; a divisão mostra para onde a venda vai.`,
    nearest: (path: string, size: string, when: string) =>
      `${path}: fatias da simulação de ${size}, o tamanho simulado mais próximo, ${when}.`,
    exact: (path: string, when: string) => `${path}: divisão simulada neste tamanho, ${when}.`,
    fee: (fee: string) => ` · taxa ${fee}`,
    tips: {
      into: (n: string, id: string, path: string) => `${n} de ${id} em: ${path}`,
      receive: (path: string, got: string, loss: string, share: string) =>
        `${path}: você recebe ${got}, uma perda de ${loss} (${share})`,
      leg: (
        path: string,
        share: string,
        amount: string,
        sales: number,
        tokens: string | null,
        pool: string,
      ) =>
        `${path}: ${share} de cada venda, ${amount}${sales > 1 ? ` em cada uma de ${sales} vendas` : ''}${
          tokens ? `, ${tokens} no total` : ''
        }, em ${pool}`,
      legCost: (path: string, cost: string | null, fee: string | null, quote: string | null) =>
        `${path}: esta perna custa ${cost ?? 'um valor não informado'} (taxa do pool ${fee ?? 'não informada'}, o resto é impacto de preço e base), paga em ${quote ?? 'token de cotação'}`,
      sol: (path: string, share: string) =>
        `${path}: ${share} da venda é paga em SOL e trocada por USDC`,
      redeem: (n: string) => `resgatar ${n} com o emissor`,
      issuerPays:
        'o que o emissor paga depende dos termos que ele publica, uma premissa de cenário',
      same: (path: string, why: string) => `${path}: a mesma venda roteada; ${why}`,
    },
    src: 'gráfico de fluxo',
  },
  methodology: {
    measured: 'O que é medido',
    measuredText:
      'A cada 5 minutos lemos o estado na rede de cada pool de DEX que negocia uma ação tokenizada (Raydium CLMM, Orca Whirlpool, Meteora DLMM, Raydium CPMM) e simulamos vender e comprar a ação por dólares em tamanhos de US$ 100 a US$ 5 milhões. A simulação reproduz a matemática de swap de cada plataforma a partir das próprias contas do pool: a liquidez em cada nível de preço, as taxas e as taxas de transferência do Token-2022. Ela é conferida com cotações da Jupiter roteadas pelo mesmo pool; a tolerância por plataforma faz parte da suíte de testes.',
    means: 'O que um número quer dizer',
    meansItems: [
      [
        'Custo',
        '= 1 − dólares recebidos ÷ (tamanho × o preço médio do pool antes da operação). Inclui a taxa do pool.',
      ],
      [
        'Capacidade em τ',
        '= a maior venda cujo custo fica em τ ou abaixo (padrão 1%), a partir de uma curva ajustada por regime de horário da semana: o custo mediano por tamanho entre os retratos, sem diminuir, interpolado em escala logarítmica. Nenhuma extrapolação além do maior tamanho medido.',
      ],
      [
        'Regimes',
        '(horário de Nova York, com horário de verão): pregão de segunda a sexta, 09:30–16:00; fora do pregão nos dias úteis; fim de semana de sexta 20:00 a domingo 20:00; feriados da NYSE. Um feriado sem dados usa a curva do fim de semana.',
      ],
      [
        'Razão de fim de semana',
        '= capacidade no fim de semana ÷ capacidade no pregão, no mesmo τ. Medida, não suposta.',
      ],
      [
        'Concentração de LPs',
        '= fatia da liquidez a até ±2% do preço guardada pelas 1, 3 e 10 maiores posições. O estresse de saída de LPs recalcula o pool sem as 3 maiores.',
      ],
      [
        'Valor recuperável',
        '= o melhor entre vender numa DEX no melhor regime dentro do horizonte e o resgate com o emissor, onde a janela abre e a liquidação cabe no horizonte. A capacidade de resgate é uma premissa de cenário, marcada como premissa; um resgate que liquida depois do horizonte aparece, mas não conta.',
      ],
      [
        'Nota de liquidez',
        '= capacidade em τ no pior regime que um horizonte pode conter, dividida por um tamanho de referência, limitada a 1. Um número com os dados que o compõem ao lado, não uma classificação.',
      ],
      [
        'Quebra',
        ': para cada saque à frente, o que precisa sair das ações depois do caixa e das pernas líquidas, contra uma fatia (padrão 25%) da capacidade do pior regime dentro da janela do saque. Quebra provável aplica o estresse seco: capacidade × máx(25%, razão de fim de semana).',
      ],
    ],
    isNot: 'O que um número não é',
    isNotItems: [
      'A profundidade medida em mercados calmos exagera a profundidade sob estresse. Cada curva mostra seu regime, o número de amostras e as datas.',
      'As curvas simulam a melhor divisão de uma venda entre os pools de saída em dólar do ativo (pools de USDC, USDT e SOL), alocada em 32 partes para o pool que paga mais pela parte seguinte. Cotações da Jupiter são coletadas a cada 15 minutos como conferência independente; a diferença é informada.',
      'Pools cotados em outros tokens (não USDC, USDT ou SOL) não contam como rotas de saída.',
      'Os números publicados são agregados por ativo e por mercado. As posições de nenhuma carteira são publicadas.',
    ],
  },
};
