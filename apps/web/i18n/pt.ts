import type { Dictionary } from './en';

// The same sentences as en.ts, as a Brazilian reads them: "você", answer first, no exclamation marks.
// The product's nouns in Portuguese: objetivo (goal), limites (limits), plano (plan), portfólio
// (portfolio), plano de saída (exit plan), rebalancear (rebalance), carteira (wallet), cofre (vault),
// rede (chain), chave de acesso (passkey). MOCK and the names of the chains are not translated.

export const pt: Dictionary = {
  shell: {
    skip: 'Pular para o conteúdo',
    nav: 'Principal',
    home: 'tenonfi, seu objetivo',
    goal: 'Objetivo',
    signIn: 'Entrar',
    signOut: 'Sair',
    signingOut: 'Saindo…',
    account: 'Sua carteira',
    disclaimer: 'Aviso',
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
    loading: 'Carregando a entrada…',
    passkey: {
      title: 'Chave de acesso',
      body: 'Sem frase-semente para anotar. Seu aparelho guarda a chave de acesso, e uma carteira é criada para você que só essa chave abre.',
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
      api: 'A entrada está desligada por enquanto: nosso servidor não está respondendo. Eu pergunto de novo a cada poucos segundos, e esta página se atualiza sozinha.',
      setup:
        'A entrada está desligada aqui: esta cópia do app não foi configurada direito. Não há nada para você corrigir. Por favor, avise a gente.',
      detail: 'Para a equipe',
    },
    failure: {
      passkeyOff:
        'As chaves de acesso ainda não estão ligadas neste app, então não dá para criar nem usar uma aqui. Conecte uma carteira ou volte mais tarde.',
      passkeyNotCreated:
        'A chave de acesso não foi criada: a janela foi fechada ou o tempo acabou. Nada foi salvo. Tente de novo quando quiser.',
      passkeyNotUsed:
        'Nenhuma chave de acesso foi usada: a janela foi fechada ou o tempo acabou. Se você ainda não tem uma chave de acesso para este site, crie uma.',
      passkeyUnknown: 'Não conheço essa chave de acesso. Crie uma nova ou conecte uma carteira.',
      passkeyUnsupported:
        'Este navegador não consegue usar chaves de acesso. Abra a página em um navegador atualizado ou conecte uma carteira.',
      walletOff:
        'A entrada com carteira ainda não está ligada neste app. Use uma chave de acesso ou volte mais tarde.',
      walletRefused:
        'Sua carteira recusou o pedido, então nada foi assinado e você não entrou. Tente de novo e aprove na carteira.',
      walletSilent: 'Essa carteira não respondeu. Abra a carteira, entre nela e tente de novo.',
      walletGone:
        'Essa carteira não está mais neste navegador. Escolha uma da lista ou use uma chave de acesso.',
      tooMany: 'Muitas tentativas em pouco tempo. Espere um minuto e tente de novo.',
      offline:
        'Não consegui falar com o serviço de entrada. Verifique sua conexão e tente de novo.',
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
      signedOut: 'Sua entrada expirou antes de a escolha ser salva. Entre de novo e escolha.',
    },
    unknown: {
      body: 'Ainda não sei dizer em qual rede seu plano fica: nosso servidor não respondeu. Não há nada de errado com a sua carteira.',
      retry: 'Perguntar de novo',
      asking: 'Perguntando…',
      signedOut:
        'Nosso servidor não reconhece mais o seu login, então não sei dizer em qual rede seu plano fica. Saia e entre de novo.',
    },
    noWallet:
      'Você entrou, mas ainda não há carteira ligada a esta entrada, então não há rede para o seu plano.',
    reading: 'Lendo onde seu plano fica…',
  },

  goal: {
    title: 'O que o seu dinheiro precisa fazer?',
    lead: 'Diga em uma frase: quanto, até quando e em quanto tempo você pode precisar do dinheiro. Eu leio isso em limites que você confere e muda. Nada é montado antes de você pedir.',
    composer: {
      label: 'Seu objetivo',
      placeholder: 'US$ 40.000 até junho de 2028, resgate em até 7 dias',
      hint: 'Enter para ler · Shift+Enter para nova linha',
      send: 'Ler meu objetivo',
      busy: 'Lendo seu objetivo…',
    },
    examples: {
      label: 'Exemplos',
      list: [
        'Juntar US$ 40.000 para um apartamento até junho de 2028',
        'US$ 1.500 por mês de renda a partir de 2029, resgate em até 7 dias',
        'Proteger US$ 25.000 por dois anos, risco baixo',
      ],
    },
    readFailure: {
      unreachable:
        'Não consegui falar com nosso servidor para ler isso. Seu texto continua aqui. Tente de novo daqui a pouco.',
      tooShort: 'Isso é curto demais para eu ler. Tente um valor e uma data.',
      unreadable:
        'Recebi uma resposta que não consegui ler. Seu texto continua aqui. Tente de novo.',
    },
    readerNote:
      'O leitor de hoje foi feito para objetivos em reais, então pode deixar passar um valor em dólares ou uma data. Confira cada campo: o que ele não encontrou ficou em branco para você.',
    sheet: {
      title: 'Como li seu objetivo',
      parser: 'leitor',
      summaryOne: '1 coisa ainda não encaixa. Corrija para montar o plano.',
      summaryOther: '{n} coisas ainda não encaixam. Corrija para montar o plano.',
      goToField: 'Ir para o campo',
      build: 'Montar meu plano',
      building: 'Montando seu plano…',
      fixOne: 'Corrija o campo acima para continuar.',
      fixOther: 'Corrija os {n} campos acima para continuar.',
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
      glide: 'Migrar para renda em dólar perto da data',
      language: 'Idioma das explicações',
      amount: 'Valor (dólares)',
    },
    hints: {
      income: 'Quanto você precisa por mês. Deixe em branco se não tiver um número.',
      horizon: 'De 1 a 480.',
      country: 'É você quem declara. Define quais ativos você pode ter.',
      holdings: 'O plano preenche lacunas e evita repetir o que você já tem.',
      amount: 'Com quanto o plano começa, de US$ 10 a US$ 1.000.000.',
    },
    captions: {
      income: 'Um plano de renda não tem ações tokenizadas.',
      protect: 'Um plano para proteger não tem ações tokenizadas: só renda em dólar, ouro e caixa.',
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
        body: (lines: number, chain: string) =>
          `Ele tem ${lines === 1 ? '1 linha' : `${lines} linhas`} na ${chain}. A tela que mostra o plano vem a seguir. Nada foi comprado.`,
      },
    },
  },
};
