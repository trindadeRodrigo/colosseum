import type { Dictionary } from './en';

// The same sentences as en.ts, as a Brazilian reads them: "você", answer first, no exclamation marks.
// The product's nouns in Portuguese: objetivo (goal), limites (limits), plano (plan), portfólio
// (portfolio), plano de saída (exit plan), rebalancear (rebalance), carteira (wallet), cofre (vault),
// rede (chain), chave de acesso (passkey), login (sign-in, the noun), rendimento em dólar (dollar
// yield), parte (a leg of a plan). MOCK and the names of the chains are not translated.

export const pt: Dictionary = {
  shell: {
    skip: 'Pular para o conteúdo',
    nav: 'Principal',
    home: 'tenonfi, seu objetivo',
    goal: 'Objetivo',
    portfolio: 'Portfólio',
    analytics: 'Análises',
    signIn: 'Entrar',
    signOut: 'Sair',
    signingOut: 'Saindo…',
    signedOut: 'Você saiu.',
    signOutFailed:
      'Não consegui encerrar sua sessão: o serviço de login não respondeu. Tente de novo.',
    account: 'Sua carteira',
    disclaimer: 'Aviso legal',
    appearance: 'Aparência',
    themes: { auto: 'Sistema', light: 'Claro', dark: 'Escuro' },
    language: 'Idioma',
    testNetwork: 'rede de teste',
    slowDown: 'Nosso servidor pediu para eu ir mais devagar. Espere um minuto e tente de novo.',
    mockAnnounce: ': dados de exemplo, não são reais',
  },

  signIn: {
    title: 'Entre com uma carteira que é sua.',
    lead: 'Seu plano fica em um cofre de onde só você pode sacar, então ele precisa de uma carteira que seja sua. Crie uma com uma chave de acesso ou conecte uma que você já usa.',
    loading: 'Carregando o login…',
    passkey: {
      title: 'Chave de acesso',
      body: 'Você não precisa anotar frase de recuperação. A chave de acesso fica no seu aparelho, e só ela abre a carteira que criamos para você.',
      create: 'Criar uma chave de acesso',
      use: 'Usar uma chave de acesso que já tenho',
      waiting: 'Aguardando sua chave de acesso…',
      making: 'Criando sua carteira…',
    },
    wallet: {
      title: 'Carteira',
      body: 'Conecte uma carteira que você já usa. Seu plano fica na rede dela: Solana para uma carteira Solana, Robinhood Chain para uma carteira Ethereum.',
      found: 'Carteiras encontradas neste navegador',
      family: { solana: 'Solana', evm: 'Ethereum' },
      waiting: 'Aguardando sua carteira…',
      none: 'Nenhuma carteira foi encontrada neste navegador. Instale uma, abra esta página no navegador da própria carteira ou use uma chave de acesso.',
    },
    off: {
      api: 'O login está indisponível no momento: nosso servidor não está respondendo. Eu tento de novo a cada poucos segundos, e esta página se atualiza sozinha.',
      setup:
        'O login está indisponível aqui: esta cópia do app não foi configurada corretamente. Não há nada para você corrigir. Por favor, avise a gente.',
      detail: 'Para a equipe',
    },
    failure: {
      passkeyOff:
        'As chaves de acesso ainda não estão ativadas neste app, então não dá para criar nem usar uma aqui. Conecte uma carteira ou volte mais tarde.',
      passkeyNotCreated:
        'A chave de acesso não foi criada: a janela foi fechada ou o tempo acabou. Nada foi salvo. Tente de novo quando quiser.',
      passkeyNotUsed:
        'Nenhuma chave de acesso foi usada: a janela foi fechada ou o tempo acabou. Se você ainda não tem uma chave de acesso para este site, crie uma.',
      passkeyUnknown: 'Não reconheço essa chave de acesso. Crie uma nova ou conecte uma carteira.',
      passkeyNotRegistered:
        'Essa chave de acesso não está registrada aqui. Escolha outra ou crie uma.',
      accountsFull:
        'Este app não está aceitando contas novas agora. Use uma chave de acesso ou carteira com que você já entrou, ou volte mais tarde.',
      notInvited:
        'Por enquanto este app é só para convidados, e este login não está na lista. Peça um convite à equipe.',
      noStorage:
        'Este navegador está bloqueando o armazenamento de que o login precisa, como faz uma janela anônima. Abra a página em uma janela normal e tente de novo.',
      passkeyUnsupported:
        'Este navegador não consegue usar chaves de acesso. Abra a página em um navegador atualizado ou conecte uma carteira.',
      walletOff:
        'O login com carteira ainda não está ativado neste app. Use uma chave de acesso ou volte mais tarde.',
      walletRefused:
        'Sua carteira recusou o pedido, então nada foi assinado e você não entrou. Tente de novo e aprove na carteira.',
      walletSilent:
        'Essa carteira não respondeu. Abra e desbloqueie a carteira, depois tente de novo.',
      walletGone:
        'Essa carteira não está mais neste navegador. Escolha uma da lista ou use uma chave de acesso.',
      tooMany: 'Muitas tentativas em pouco tempo. Espere um minuto e tente de novo.',
      offline: 'Não consegui falar com o serviço de login. Verifique sua conexão e tente de novo.',
      expired: 'Isso demorou demais e o tempo acabou. Tente de novo.',
      walletNotMade:
        'Você entrou, mas sua carteira não pôde ser criada. Nada foi perdido. Tente de novo.',
      other:
        'Não deu certo, e não sei dizer por quê. Tente de novo. Se continuar acontecendo, conte para a gente o que você estava fazendo.',
    },
    done: {
      title: 'Você entrou.',
      noWallet: 'Nenhuma carteira sua está conectada neste navegador.',
      next: 'Ir para o seu objetivo',
      retryWallet: 'Criar minha carteira',
    },
  },

  chain: {
    names: { solana: 'Solana', robinhood: 'Robinhood Chain', base: 'Base' },
    pick: {
      title: 'Escolha a rede onde seu plano vai ficar',
      asked: {
        made: 'Você criou sua carteira aqui, então é você quem escolhe a rede dela, uma única vez.',
        connected:
          'Você conectou carteiras em duas redes, então é você quem escolhe em qual delas seu plano fica, uma única vez.',
      },
      body: 'Seu depósito, seu cofre e todas as operações do plano ficam nessa rede. Cada rede tem sua própria prateleira de ativos, e um plano é montado só com a prateleira da rede dele: nunca é dividido entre duas.',
      warning: 'Isso não pode ser mudado depois.',
      group: 'A rede do seu plano',
      address: (address: string) => `Sua carteira lá: ${address}`,
      confirm: (chain: string) => `Meu plano fica na ${chain}`,
      confirmNone: 'Escolha uma rede',
      saving: 'Salvando sua escolha…',
      why: 'Escolha uma rede para continuar.',
      off: (chain: string) =>
        `${chain} está indisponível no nosso servidor por enquanto, então não pode ser escolhida.`,
      noneOn: 'Nenhuma rede pode ser escolhida agora. Nada foi perdido: volte mais tarde.',
      mock: 'A carteira descartável não tem conta no nosso servidor, então esta escolha fica só nesta aba.',
    },
    is: {
      picked: (chain: string) => `Seu plano fica na ${chain}. Você escolheu, e isso não muda.`,
      wallet: (chain: string) =>
        `Seu plano fica na ${chain}, a rede da carteira que você conectou.`,
    },
    failure: {
      taken: (stored: string, tried: string) =>
        `Seu plano já fica na ${stored}: isso foi escolhido antes, em outro aparelho ou em outra aba, e não pode ser mudado. ${tried} não foi salva.`,
      takenUnknown: (tried: string) =>
        `${tried} não foi salva: uma rede já tinha sido escolhida para o seu plano, em outro aparelho ou em outra aba, e isso não pode ser mudado.`,
      notOffered: 'Essa rede não pode ser escolhida com esta carteira. Escolha a outra.',
      unreachable:
        'Não consegui salvar: nosso servidor não respondeu. Sua escolha ainda não está guardada. Tente de novo.',
      signedOut: 'Sua sessão expirou antes de a escolha ser salva. Entre de novo e escolha.',
      noIdentity:
        'Não consegui salvar: o serviço de login não me entregou a parte do seu login que lista suas carteiras, então nosso servidor não consegue conferi-las. Sua escolha ainda não está guardada. Espere um minuto e tente de novo.',
    },
    unknown: {
      body: 'Ainda não sei dizer em qual rede seu plano fica: nosso servidor não respondeu. Não há nada de errado com a sua carteira.',
      retry: 'Perguntar de novo',
      asking: 'Perguntando…',
      signedOut:
        'Nosso servidor não reconhece mais o seu login, então não sei dizer em qual rede seu plano fica. Saia e entre de novo.',
      noIdentity:
        'Ainda não sei dizer em qual rede seu plano fica: o serviço de login não me entregou a parte do seu login que lista suas carteiras, então nosso servidor não consegue conferi-las. Não há nada de errado com a sua carteira. Espere um minuto e pergunte de novo.',
    },
    noWallet:
      'Você entrou, mas ainda não há carteira vinculada ao seu login, então não há rede para o seu plano.',
    reading: 'Verificando em qual rede seu plano fica…',
  },

  goal: {
    title: 'O que o seu dinheiro precisa fazer?',
    lead: 'Diga em uma frase: com quanto você começa, por quanto tempo e quanto risco aceita. Eu transformo isso em limites que você pode conferir e mudar. Nada é montado antes de você pedir.',
    composer: {
      label: 'Seu objetivo',
      placeholder:
        'Descreva seu objetivo… um valor, uma data e com que rapidez você pode precisar do dinheiro de volta.',
      hint: 'Enter para ler · Shift+Enter para nova linha',
      submit: 'Ler meu objetivo',
      busy: 'Lendo seu objetivo…',
    },
    visitor: {
      before: 'Gostou de como ficou?',
      link: 'Entre',
      after: 'para ter um plano na rede da sua carteira, com a fonte de cada número.',
    },
    examples: {
      label: 'Exemplos',
      list: [
        'Fazer US$ 2.000 crescerem por dez anos, risco alto',
        'Proteger US$ 50.000 por 18 meses, risco baixo',
        'US$ 80.000 para ter US$ 300 por mês de renda',
      ],
    },
    readFailure: {
      unreachable:
        'Não consegui falar com nosso servidor para ler isso. Seu texto continua aqui. Tente de novo daqui a pouco.',
      tooShort: 'Isso é curto demais para eu ler. Tente um valor e um prazo.',
      tooLong: 'Isso é longo demais para eu ler. Use até 2.000 caracteres.',
      unreadable:
        'Recebi uma resposta que não consegui ler. Seu texto continua aqui. Tente de novo.',
    },
    readerNote:
      'O leitor de hoje foi feito para objetivos em reais, então pode deixar passar um valor em dólares ou uma data. Confira cada campo: o que ele não encontrou ficou em branco para você.',
    readerMissed: (fields: string) =>
      `O leitor de hoje foi feito para objetivos em reais, então não encontrou isto no seu objetivo: ${fields}. Preencha abaixo. Nada é montado até que todos os campos estejam certos.`,
    sheet: {
      title: 'Como li seu objetivo',
      parser: 'leitor',
      summaryOne: '1 coisa ainda não se encaixa. Corrija para montar o plano.',
      summaryOther: '{n} coisas ainda não se encaixam. Corrija para montar o plano.',
      missingOne: 'Ainda falta 1 coisa. Preencha para montar o plano.',
      missingOther: 'Ainda faltam {n} coisas. Preencha para montar o plano.',
      goToField: 'Ir para o campo',
      build: 'Montar meu plano',
      building: 'Montando seu plano…',
      fixOne: 'Corrija o campo acima para continuar.',
      fixOther: 'Corrija os {n} campos acima para continuar.',
      fillOne: 'Preencha o campo acima para continuar.',
      fillOther: 'Preencha os {n} campos acima para continuar.',
      reading: 'Lendo seu objetivo…',
      noPlan: 'Nenhum plano cabe nesses limites.',
      editSheet: 'Editar limites',
      edited: 'editado',
    },
    groups: {
      goal: 'Objetivo',
      time: 'Prazo e risco',
      shape: 'O que molda o plano',
      words: 'Palavras',
    },
    fields: {
      goal: 'Para que é o dinheiro',
      income: 'Renda mensal (dólares)',
      horizon: 'Prazo (meses)',
      risk: 'Tolerância a risco',
      country: 'País onde você mora',
      holdings: 'Contar o que você já tem',
      glide: 'Migrar para rendimento em dólar perto da data',
      language: 'Idioma das explicações',
      amount: 'Valor (dólares)',
    },
    hints: {
      income: 'Quanto você precisa por mês. Deixe em branco se não tiver um número.',
      horizon: 'De 1 a 480.',
      country: 'É você quem declara. Define quais ativos você pode ter.',
      holdings: 'O plano preenche lacunas e evita repetir o que você já tem.',
      amount: 'Com quanto o plano começa, de US$ 10 a US$ 1.000.000.',
      notFound: 'Não encontrei no seu objetivo: preencha.',
    },
    captions: {
      income: 'Um plano de renda não tem ações tokenizadas.',
      protect:
        'Um plano para proteger não tem ações tokenizadas: só rendimento em dólar, ouro e caixa.',
    },
    options: {
      choose: 'Escolha',
      goal: { grow: 'Fazer crescer', income: 'Gerar renda', protect: 'Proteger' },
      risk: { low: 'Baixa', medium: 'Média', high: 'Alta' },
      yes: 'Sim',
      no: 'Não',
      language: { en: 'English', pt: 'Português' },
    },
    errors: {
      goal: 'Escolha para que é o dinheiro.',
      amountEmpty: 'Informe o valor em dólares.',
      amountNumber: 'Informe o valor como número, por exemplo 40000.',
      amountLow: 'Informe pelo menos US$ 10.',
      amountHigh: 'Informe US$ 1.000.000 ou menos.',
      horizon: 'Informe o prazo em meses inteiros, de 1 a 480.',
      risk: 'Escolha quanto risco você aceita.',
      country: 'Escolha o país onde você mora.',
      income: 'Informe a renda mensal como número maior que zero, ou deixe em branco.',
      language: 'Escolha um idioma.',
    },
    chain: {
      label: 'Rede',
      note: 'A rede da sua carteira. O plano, o cofre dele e todas as operações ficam nela.',
      unset: 'Não definida',
      unsetNote: 'Um plano é montado para a rede da sua carteira.',
      choose: 'Escolher a rede',
      unknown: 'Ainda não sei',
    },
    blocked: {
      signedOut: 'Entre para montar: um plano é montado para a rede da sua carteira.',
      chainNotChosen: 'Escolha primeiro a rede onde seu plano vai ficar.',
      chainUnknown:
        'Ainda não sei em qual rede seu plano fica, então não consigo montar para ela. Pergunte de novo, acima.',
      refused: 'Nosso servidor não aceitou esses limites. Confira cada campo e tente de novo.',
      signInAgain:
        'Nosso servidor não reconhece mais o seu login, então o plano não foi montado. Saia e entre de novo.',
      noIdentity:
        'O plano não foi montado: o serviço de login não me entregou a parte do seu login que lista suas carteiras, então nosso servidor não consegue conferi-las. Seus limites continuam guardados. Espere um minuto e tente de novo.',
      chainOff: (chain: string) =>
        `${chain} está indisponível no nosso servidor por enquanto, então não consigo montar um plano nela. Seus limites continuam guardados.`,
    },
    card: {
      sentence: {
        grow: (amount: string, months: string) => `Fazer ${amount} crescer em ${months}.`,
        income: (amount: string, months: string) => `Gerar renda com ${amount} por ${months}.`,
        protect: (amount: string, months: string) => `Proteger ${amount} por ${months}.`,
      },
      months: (n: number) => (n === 1 ? '1 mês' : `${n} meses`),
      unfinished: 'Seu objetivo, como foi lido até aqui.',
      draftOpen: 'Rascunho: termine os limites',
      draftSet: 'Rascunho: limites definidos, ainda sem plano',
      edit: 'Editar limites',
    },
    built: {
      unavailable: {
        title: 'Seus limites estão definidos. O plano ainda não pode ser montado.',
        body: 'A parte do nosso servidor que monta um plano a partir desses limites ainda não está conectada. Não vou mostrar um plano inventado no lugar. Seus limites ficam guardados nesta aba do navegador.',
      },
      unreachable:
        'Não consegui falar com nosso servidor para montar o plano. Seus limites continuam como estão. Tente de novo.',
      unreadable:
        'Nosso servidor respondeu com um plano que não consegui ler, então não vou mostrar. Seus limites continuam como estão. Tente de novo.',
      done: {
        title: 'Seu plano está montado.',
        body: (parts: number, chain: string) =>
          `Ele tem ${parts === 1 ? '1 parte' : `${parts} partes`} na ${chain}. Nada foi comprado.`,
        see: 'Ver seu plano',
      },
    },
  },

  pin: {
    sourceFor: 'Fonte de {value}',
    staleSuffix: ', desatualizado, {age}',
    mockSuffix: ', dados de exemplo',
    stale: 'desatualizado',
    ageUnknown: 'idade desconhecida',
    missing: 'ainda sem fonte',
    provenance: 'Procedência',
    copy: 'Copiar fonte',
    copied: 'Copiado',
    kinds: {
      mock: 'dados MOCK, não reais',
      sandbox: 'rede de teste, não real',
      fixture: 'dados fixos, não reais',
      prior_dataset: 'dados anteriores, não reais',
    },
    unknownKind: 'não real',
  },

  portfolio: {
    title: (vaults: number) =>
      vaults > 1 ? 'O que seus cofres guardam.' : 'O que seu cofre guarda.',
    lead: 'Lido da rede onde seu plano fica, cada vez que você abre esta página. Nada aqui assina ou move coisa alguma.',
    chain: 'Rede',
    reading: 'Lendo seu cofre…',
    signedOut:
      'Entre para ver seu portfólio. Ele fica em um cofre na rede da sua carteira, e só você pode sacar dele.',
    noChain: 'Primeiro escolha a rede onde seu plano fica: seu cofre está nessa rede.',
    chooseChain: 'Escolher a rede',
    throwaway:
      'A carteira descartável não tem conta no nosso servidor, então não há cofre dela para ler.',
    unavailable:
      'Este servidor ainda não lê cofres, então não há nada para mostrar aqui. Não vou mostrar posições inventadas no lugar.',
    down: {
      word: 'Indisponível',
      body: (chain: string) =>
        `A ${chain} não respondeu, então não consigo ler seu cofre agora. Não conseguir lê-lo não move nada. Tente de novo daqui a pouco.`,
    },
    unreachable: 'Não consegui falar com nosso servidor para ler seu cofre. Tente de novo.',
    unreadable:
      'Nosso servidor respondeu com algo que não consegui ler, então não vou mostrar. Tente de novo.',
    signInAgain:
      'Nosso servidor não reconhece mais seu login, então não consigo ler seu cofre. Saia e entre de novo.',
    noIdentity:
      'Ainda não consigo ler seu cofre: o serviço de login não me deu a parte do seu login que lista suas carteiras. Espere um minuto e tente de novo.',
    again: 'Ler de novo',
    againBusy: 'Lendo…',
    empty: (chain: string) =>
      `Você ainda não tem cofre na ${chain}. Um cofre é criado quando você compra seu primeiro plano.`,
    startGoal: 'Comece pelo seu objetivo',
    vault: {
      title: 'Seu cofre',
      address: 'Endereço do cofre',
      value: 'Valor',
      cash: 'Caixa',
      autoFollow: 'Seguir automaticamente',
      on: 'Ativado',
      off: 'Desativado',
      lossUsed: 'Perdas do agente, últimos 7 dias',
      holdings: 'Posições',
      onlyCash: 'Só caixa por enquanto: nada foi comprado para este cofre ainda.',
      columns: {
        asset: 'Ativo',
        amount: 'Quantidade',
        price: 'Preço',
        value: 'Valor',
        weight: 'Peso',
        target: 'Alvo',
        drift: 'Desvio',
      },
      noPrice: 'sem preço',
      unpriced: (n: number) =>
        n === 1
          ? '1 posição não tem preço, então o valor a deixa de fora.'
          : `${n} posições não têm preço, então o valor as deixa de fora.`,
      pending: (version: number, when: string) =>
        `A versão ${version} do portfólio que você segue começa a valer em ${when}.`,
      pendingAssets: (assets: string) => `Ela inclui ${assets}, que você ainda não aceitou.`,
      observed: (when: string) => `Lido da rede em ${when}.`,
      valueMethod: 'posições lidas do cofre, vezes seus preços; caixa a um dólar',
      positionMethod: (method: string) => `${method}; vezes a quantidade que o cofre guarda`,
    },
    summary: {
      title: 'Seu portfólio',
      worth: (chain: string) => `Seu cofre na ${chain} vale`,
      many: (vaults: number, chain: string) => `Você tem ${vaults} cofres na ${chain}.`,
      see: 'Ver seu portfólio',
    },
  },

  plan: {
    title: 'Seu plano',
    signedOut: 'Entre para ver este plano. Um plano é de uma pessoa, na rede da carteira dela.',
    missing: {
      title: 'Não tenho este plano nesta aba.',
      body: 'Um plano fica guardado na aba do navegador que o montou, e este não está aqui. Monte de novo a partir do seu objetivo: seus limites continuam guardados.',
    },
    backToGoal: 'Voltar ao seu objetivo',
    otherChain: (plan: string, yours: string) =>
      `Este plano foi feito para ${plan}, e seus planos ficam em ${yours}. Monte de novo a partir do seu objetivo.`,
    lead: (chain: string) =>
      `Montado para ${chain}, a partir dos seus limites. Nada é comprado antes de você revisar cada passo e assinar.`,
    holds: 'O que ele tem',
    sub: (risk: string, chain: string) => `${risk} · em ${chain} · nada comprado ainda`,
    riskWord: { low: 'Risco baixo', medium: 'Risco médio', high: 'Risco alto' },
    chips: {
      label: 'Seus limites',
      goal: 'objetivo',
      amount: 'valor',
      horizon: 'prazo',
      risk: 'risco',
      chain: 'rede',
    },
    kpi: {
      amount: 'você coloca',
      horizon: 'por',
      projected: 'projetado ao ano',
      loss: 'numa queda forte',
      estimate: 'estimativa',
    },
    legs: { afterHaircut: 'após desconto', quoted: 'cotado {rate}' },
    exitPlan: 'Plano de saída',
    costPrefix: 'custo',
    foot: { sandbox: 'rede de teste, não real', mock: 'dados de exemplo, não reais' },
    columns: { asset: 'Ativo', share: 'Parte', amount: 'Valor', why: 'Por quê' },
    noReason: 'Nenhum motivo informado.',
    projected: 'Faixa projetada por ano, não é uma promessa',
    projectedValue: (low: string, high: string) => `${low} a ${high}`,
    basis: (basis: string) => `Como foi calculada: ${basis}.`,
    lossInFall: (amount: string) =>
      `Numa queda forte, o motor conta uma perda de cerca de ${amount} neste plano.`,
    exitUnmeasured: 'Ainda não foi medido, então nenhum custo é mostrado.',
    exitCost: (cost: string) => `≤ ${cost}`,
    inKind: 'Você também pode tirar os próprios tokens do seu cofre a qualquer momento.',
    risk: {
      title: 'Risco, como nosso servidor resumiu',
      byClass: 'Por tipo de ativo',
      byIssuer: 'Por emissor',
      share: 'Parte',
      name: 'Nome',
      exitQuoted: 'Custo para vender, última cotação',
      exitMeasured: 'Custo para vender, pior medido',
      measuredShare: 'Parte do plano medida',
      notMeasured: 'não medido',
    },
    flags: 'O que o motor sinalizou',
    verdict: {
      met: 'A renda que você pediu é atendida por este plano, nos números do motor.',
      gap: (gap: string) => `Este plano fica ${gap} por mês abaixo da renda que você pediu.`,
    },
    buy: 'Comprar este plano',
    chainNotReady: (chain: string) =>
      `${chain} ainda não está pronta para compras: os cofres dela não estão implantados nesta rede. Seu plano fica guardado e pode ser comprado quando estiverem.`,
    chainOff: (chain: string) =>
      `${chain} está indisponível no nosso servidor por enquanto, então este plano ainda não pode ser comprado nela.`,
  },

  trust: {
    title: 'Antes do seu primeiro depósito',
    lead: 'Leia isto uma vez. É nisso que você confia quando coloca dinheiro em um cofre.',
    unaudited: 'O código dos cofres não foi auditado por ninguém de fora da equipe.',
    keys: 'A equipe tem as chaves que atualizam o código dos cofres. Uma atualização pode mudar o que um cofre faz, então a equipe poderia mover fundos.',
    admin: (address: string) => `A chave que o atualiza: ${address}.`,
    keeper: (tolerance: string, loss: string) =>
      `Com o seguir automático ativado, nosso operador só pode negociar os ativos do seu plano, no máximo ${tolerance} pior que o preço de referência, e perder no máximo ${loss} do seu cofre numa semana. Erros no preço de referência somam a isso. Você pode desativar o seguir automático e sacar a qualquer momento.`,
    keeperUnset:
      'Os limites do operador nesta rede ainda não estão definidos, então o seguir automático não é oferecido aqui.',
    issuers: 'Os emissores de tokens de ações podem pausar, congelar ou retomar seus tokens.',
    notUnitedStates: 'Este produto não é para pessoas nos Estados Unidos.',
    passkey:
      'Uma chave de acesso perdida e não sincronizada com outro aparelho perde a carteira que ela abre. Adicione uma segunda forma de entrar depois do primeiro depósito.',
    openChecks: (list: string) =>
      `Verificações ainda não feitas, então o que elas encontrarem não está neste aviso: ${list}.`,
    checks: {
      evm_invariants: 'as invariantes dos contratos dos cofres sob chamadas hostis',
      solana_sequences: 'sequências aleatórias das instruções do programa na Solana',
      static_analysis: 'a análise estática dos programas e contratos',
      robinhood_fork: 'uma execução numa cópia da Robinhood Chain',
      second_rehearsal: 'um segundo ensaio na rede principal com a chave de administração',
    },
    accept: 'Li e aceito',
    accepted: 'Você aceitou este aviso neste navegador.',
  },

  buy: {
    title: 'Comprar seu plano',
    lead: (chain: string) =>
      `O valor inteiro vai para um cofre de onde só você pode sacar, em ${chain}, e então compra cada ativo do plano.`,
    amount: {
      label: 'Valor (dólares)',
      hint: (planned: string) =>
        `De US$ 10 a US$ 1.000.000. Seu plano foi montado para ${planned}.`,
    },
    funding: {
      title: 'O que sua carteira precisa',
      reading: 'Lendo sua carteira…',
      cash: (symbol: string) => `Dinheiro para depositar (${symbol})`,
      gas: (symbol: string) => `Taxas da rede (${symbol})`,
      have: 'Você tem',
      need: 'Esta compra precisa',
      missing: 'Faltam',
      ok: 'Sua carteira tem o que esta compra precisa.',
      short: (chain: string) =>
        `Falta na sua carteira o que esta compra precisa. Adicione o que falta à sua carteira em ${chain} e leia de novo.`,
      address: (address: string) => `Seu endereço lá: ${address}`,
      newVault:
        'Esta compra abre o seu cofre para este plano, o que custa um pouco mais de taxa na primeira vez.',
      readAgain: 'Ler minha carteira de novo',
      mockFund: 'Adicionar dinheiro e taxas MOCK',
      mockFunding: 'Adicionando…',
      failure: {
        unreachable: 'Não consegui ler sua carteira: nosso servidor não respondeu. Tente de novo.',
        unreadable:
          'Nosso servidor respondeu sobre sua carteira num formato que não consegui ler. Tente de novo.',
        noPlan: 'Nosso servidor não tem este plano. Monte de novo a partir do seu objetivo.',
        refused: 'Nosso servidor não aceitou este valor. Confira e tente de novo.',
      },
    },
    review: (amount: string) => `Revisar os passos para comprar ${amount}`,
    reviewing: 'Criando sua ordem…',
    blocked: {
      amount: 'Digite um valor de US$ 10 a US$ 1.000.000 para continuar.',
      funding: 'Sua carteira precisa do que falta acima antes de você continuar.',
      trust: 'Aceite o aviso acima para continuar.',
      wallet: 'Nenhuma carteira sua está conectada nesta rede.',
    },
    failure: {
      NOT_FUNDED:
        'Sua carteira não tem mais o suficiente para esta compra. Leia de novo e tente outra vez.',
      ASSET_NOT_ELIGIBLE:
        'Um ativo deste plano não pode ser comprado nesta rede agora. Monte o plano de novo a partir do seu objetivo.',
      VERSION_CHANGED:
        'Um portfólio compartilhado deste plano mudou depois que o plano foi feito. Monte o plano de novo a partir do seu objetivo.',
      ORDER_EXPIRED: 'Essa ordem perdeu o prazo. Tente de novo.',
      US_PERSON:
        'Este produto não é para pessoas nos Estados Unidos, então a ordem não foi criada.',
      RATE_LIMITED:
        'Nosso servidor pediu para eu ir mais devagar. Espere um minuto e tente de novo.',
      CHAIN_UNAVAILABLE:
        'Esta rede está indisponível no nosso servidor por enquanto. Nada foi pedido.',
      unreachable:
        'Não consegui falar com nosso servidor, então nenhuma ordem foi criada. Tente de novo.',
      unreadable:
        'Nosso servidor respondeu com uma ordem que não consegui ler, então não vou mostrá-la. Nada foi assinado.',
      noPlan: 'Nosso servidor não tem este plano. Monte de novo a partir do seu objetivo.',
      refused: 'Nosso servidor não aceitou esta ordem. Confira o valor e tente de novo.',
      signedOut: 'Nosso servidor não reconhece mais o seu login. Saia e entre de novo.',
      noChain: 'Escolha primeiro a rede onde seu plano fica.',
      noStore:
        'Este navegador não guarda nada entre páginas, então não consigo guardar sua ordem. Permita que este site guarde dados e tente de novo.',
    },
  },

  order: {
    title: 'Sua ordem',
    loading: 'Lendo sua ordem…',
    signedOut: 'Entre para ver esta ordem. Uma ordem é de uma pessoa, e só ela pode assinar.',
    failure: {
      notFound: 'Não encontro esta ordem para você. Ela pode ser de outro login.',
      unreachable: 'Não consegui ler sua ordem: nosso servidor não respondeu. Tente de novo.',
      unreadable:
        'Nosso servidor respondeu com uma ordem que não consegui ler, então não vou mostrá-la.',
      retry: 'Ler de novo',
    },
    elsewhere:
      'Esta ordem foi criada em outro navegador, então o plano dela não está aqui para conferir os passos. Abra onde você a criou ou crie uma nova ordem.',
    review: {
      title: 'Revise cada passo',
      lead: 'Cada passo é montado na hora, conferido com o que você vê aqui, e só então assinado pela sua carteira. Um passo que não confere não é assinado.',
      deposit: 'Depósito',
      steps: 'Passos',
      expires: 'Assine antes de',
      spend: (amount: string, asset: string) => `Gastar ${amount} em ${asset}`,
      atLeast: (amount: string, asset: string) =>
        `receber pelo menos ${amount} de ${asset}, em suas menores unidades`,
      atLeastWhole: (amount: string) => `receber pelo menos ${amount}`,
      under: (pct: string) => `${pct} abaixo da cotação`,
      noTrades: 'Nenhuma negociação neste passo.',
      warnings: 'Nosso servidor avisa',
      consents: 'Com o que você concorda nesta ordem',
      consent: {
        auto_follow_on:
          'Ativar o seguir automático: nosso operador negocia seu cofre em direção ao portfólio, dentro dos limites acima.',
        new_asset: 'Aceitar uma versão do portfólio com um ativo que você ainda não tem.',
        publish:
          'Publicar este portfólio, ou retirá-lo, em seu nome: outras pessoas podem vê-lo e segui-lo.',
      },
      consentNeeded: 'Marque cada concordância acima para continuar.',
    },
    mismatch: {
      units:
        'Não consigo conferir os valores desta ordem: este app não tem registro do dinheiro nesta rede. Nada será assinado.',
      deposit:
        'Esta ordem não deposita o valor que você pediu, então não vou oferecer a assinatura. Nada foi assinado. Crie uma nova ordem e avise a gente se acontecer de novo.',
      steps:
        'Um passo desta ordem move outro valor em dinheiro que não o do depósito, então não vou oferecer a assinatura. Nada foi assinado. Crie uma nova ordem e avise a gente se acontecer de novo.',
    },
    signAndBuy: (amount: string) => `Assinar e comprar ${amount}`,
    resume: (amount: string) => `Continuar a compra de ${amount}`,
    signing: (n: number, total: number) => `Assinando o passo ${n} de ${total}…`,
    stepsTitle: 'Passos',
    step: (n: number) => `Passo ${n}`,
    kind: {
      approve: 'Autorizar o depósito',
      create_vault: 'Abrir seu cofre e depositar',
      deposit: 'Depositar',
      swap: 'Comprar',
      set_targets: 'Definir as metas do seu cofre',
      accept_version: 'Aceitar uma nova versão',
      set_auto_follow: 'Mudar o seguir automático',
      withdraw: 'Sacar',
      publish: 'Publicar',
      adopt_version: 'Operador: adotar uma versão',
      keeper_leg: 'Operador: negociar',
    },
    status: {
      planned: 'Não começou',
      built: 'Montado, ainda não assinado',
      sent: 'Enviado, aguardando a rede',
      confirmed: 'Confirmado',
      failed: 'Falhou',
      expired: 'Perdeu o prazo',
      skipped: 'Pulado',
    },
    phase: {
      building: 'Montando…',
      checking: 'Conferindo com a sua revisão…',
      signing: 'Assinando…',
      reporting: 'Enviando…',
      landing: 'Aguardando a rede…',
      waiting: 'Aguardando…',
      settled: 'Concluído',
    },
    explorer: 'explorador',
    signature: 'assinatura',
    notRetried: '(sem nova tentativa)',
    link: {
      tx: 'Tx',
      view: 'Ver a transação {signature} no {explorer}',
      unavailable: 'link indisponível',
    },
    outcome: {
      done: (chain: string) =>
        `Todos os passos estão confirmados em ${chain}, segundo nosso servidor. A transação de cada passo está no link ao lado dele.`,
      refused: (step: number) =>
        `Não assinei o passo ${step}: a transação que nosso servidor montou para ele não é o passo que você aprovou. Nada foi assinado para ele.`,
      refusedOrder:
        'Não assinei nada: esta ordem não diz o suficiente para eu conferir os passos. Crie uma nova ordem.',
      refusedWhy: {
        moved:
          'O preço mudou desde a sua revisão, então o mínimo do passo não é mais o que você viu. Revise uma nova ordem.',
        mismatch:
          'Algo nele difere do que você aprovou. Crie uma nova ordem; se acontecer de novo, avise a gente.',
        setup:
          'Este app ainda não consegue conferir passos nesta rede. Nada pode ser assinado aqui por enquanto.',
      },
      check: (code: string) => `Conferência que falhou: ${code}`,
      cancelled: (step: number) =>
        `Sua carteira não assinou o passo ${step}, então ele não foi enviado. Nada se moveu por ele. Você pode tentar de novo.`,
      failed: (step: number) =>
        `O passo ${step} chegou à rede e falhou. Ele não é enviado de novo: uma nova tentativa é você quem pede, com uma nova ordem.`,
      expired:
        'Esta ordem perdeu o prazo antes de todos os passos serem assinados. Crie uma nova ordem para o resto.',
      blocked:
        'Outra ordem desta carteira tem uma transação que ainda pode chegar. Termine ou cancele aquela ordem primeiro.',
      blockedLink: 'Abrir aquela ordem',
      needsReview: (step: number, times: number) =>
        `O passo ${step} foi assinado ${times === 1 ? 'uma vez' : `${times} vezes`} antes e ainda pode chegar. Não consigo saber pela rede se ainda pode, então não vou assinar de novo sem você dizer. Se você aprovar de novo, ele pode acontecer duas vezes.`,
      approveAgain: (step: number) => `Assinar o passo ${step} de novo`,
      waiting: {
        landing:
          'Sua ordem está a caminho: um passo foi enviado e a rede ainda não o recebeu. Olhe de novo em um minuto.',
        in_flight:
          'Sua ordem está a caminho: um passo assinado antes ainda pode chegar. Olhe de novo em um minuto.',
        unseen:
          'Sua ordem está a caminho: nosso servidor ainda não viu o último passo na rede. Olhe de novo em um minuto.',
        stopped: 'Parado. O que foi assinado fica guardado e é informado quando você continuar.',
        unknown_blockhash:
          'O nó da rede que este app lê não está atualizado, então nada foi assinado. Olhe de novo em um minuto.',
      },
      lookAgain: 'Olhar de novo',
      error:
        'Nosso servidor recusou ou não respondeu, então a ordem parou. O que foi assinado fica guardado. Tente de novo.',
      tryAgain: 'Tentar de novo',
      elsewhere:
        'Esta ordem está rodando em outra aba deste navegador. Acompanhe por lá; nada foi feito aqui.',
      notRunnable: {
        'no-deployment': (chain: string) =>
          `${chain} ainda não está pronta para compras: os cofres dela não estão implantados nesta rede. Nada foi assinado.`,
        'no-wallet':
          'Nenhuma carteira sua está conectada na rede desta ordem, então nada foi assinado.',
        'no-store':
          'Este navegador não guarda nada entre páginas, então não vou assinar: um passo poderia ser assinado duas vezes. Permita que este site guarde dados e tente de novo.',
        'no-lock':
          'Este navegador não consegue manter uma ordem em uma só aba, então não vou assinar aqui. Abra a página num navegador atual.',
        'plan-mismatch':
          'O plano guardado para esta ordem é de outra rede, então nada foi assinado. Crie uma nova ordem.',
      },
      crashed: 'Algo parou a ordem antes do fim. O que foi assinado fica guardado. Tente de novo.',
      newOrder: 'Criar uma nova ordem',
    },
  },

  bearing: {
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
      staleAll:
        'Todo número está defasado: medido, apenas antigo. A idade de cada um está ao lado.',
      down: (api: string) => `A API de risco em ${api} não respondeu.`,
      downAll: 'Cada número desta página espera por ela; nenhum é inventado no lugar.',
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
    pie: {
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
      summary: (n: number, regime: string) =>
        `${n} ${n === 1 ? 'pool' : 'pools'} · agora ${regime}`,
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
        best: (
          n: string,
          id: string,
          path: string,
          atLeast: boolean,
          loss: string,
          share: string,
        ) =>
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
  },
};
