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
    home: 'tenonfi, início',
    menu: 'Menu',
    invest: 'Investir',
    portfolio: 'Portfólio',
    products: 'Produtos',
    resources: 'Recursos',
    analytics: 'Análises',
    shelf: 'Prateleira',
    signIn: 'Entrar',
    signOut: 'Sair',
    signingOut: 'Saindo…',
    signedOut: 'Você saiu.',
    signOutFailed:
      'Não consegui encerrar sua sessão: o serviço de login não respondeu. Tente de novo.',
    account: 'Sua carteira',
    address: 'Endereço',
    copyAddress: 'Copiar endereço',
    copied: 'Copiado',
    viewOn: (explorer: string) => `Ver no ${explorer}`,
    disclaimer: 'Aviso legal',
    appearance: 'Aparência',
    themes: { auto: 'Sistema', light: 'Claro', dark: 'Escuro' },
    language: 'Idioma',
    testNetwork: 'rede de teste',
    slowDown: 'Nosso servidor pediu para eu ir mais devagar. Espere um minuto e tente de novo.',
    mockAnnounce: 'Números de exemplo',
    sampleFigure: 'número de exemplo',
    wait: {
      slow: 'Acordando o serviço de dados: da primeira vez isso pode levar até um minuto.',
      over: 'Nosso servidor não respondeu a tempo, então nada aparece aqui ainda.',
      retry: 'Tentar de novo',
    },
  },

  signIn: {
    title: 'Entre com uma carteira que é sua.',
    lead: 'Seu plano fica em um cofre de onde só você pode sacar, então ele precisa de uma carteira que seja sua. Crie uma com uma chave de acesso ou conecte uma que você já usa.',
    loading: 'Carregando o login…',
    notLoaded: 'O login não carregou aqui.',
    openPage: 'Abrir a página de login',
    close: 'Fechar o login',
    passkey: {
      title: 'Chave de acesso',
      body: 'Você não precisa anotar frase de recuperação. Eu uso a chave de acesso que este aparelho guarda para este site. A carteira que criamos para você só abre com essa chave.',
      continue: 'Continuar com uma chave de acesso',
      createNew: 'Criar uma chave de acesso nova',
      waiting: 'Aguardando sua chave de acesso…',
      making: 'Criando sua carteira…',
    },
    wallet: {
      title: 'Carteira',
      body: 'Conecte uma carteira que você já usa. Seu plano fica na rede dela: Solana para uma carteira Solana, Robinhood Chain para uma carteira Ethereum.',
      connect: 'Conectar uma carteira',
      found: 'Carteiras encontradas neste navegador',
      waiting: 'Aguardando sua carteira…',
      none: 'Nenhuma carteira foi encontrada neste navegador. Instale uma ou abra esta página no navegador da própria carteira. Ou continue com uma chave de acesso: não precisa instalar nada.',
      both: (wallet: string) =>
        `${wallet} funciona na Solana e na Robinhood Chain. Escolha a rede onde seu plano fica: isso não pode ser mudado depois.`,
      before: 'Já entrou antes? Escolha a rede que você escolheu naquela vez.',
      off: (wallet: string) =>
        `${wallet} só funciona em redes indisponíveis no nosso servidor por enquanto, então não pode ser usada para entrar. Use outra carteira ou uma chave de acesso.`,
      chains: 'A rede do seu plano',
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
        'Nenhuma chave de acesso foi usada. Se você criou uma em outro aparelho, use esse aparelho ou escolha “usar um celular” na janela. É novo aqui? Crie uma chave de acesso: ela abre uma conta nova, com uma carteira nova e vazia.',
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
    short: { solana: 'Solana', robinhood: 'Robinhood', base: 'Base' },
    explorers: { solana: 'Solscan', robinhood: 'explorador da Robinhood', base: 'Basescan' },
    switch: {
      current: (chain: string) => `Rede: ${chain}`,
      group: 'Escolha uma rede',
      plansStay:
        'Planos novos são montados na rede que você escolher. Os planos que você já tem continuam na rede deles.',
      browsing: 'Mostra os portfólios compartilhados dessa rede.',
      noWallet: (chain: string) => `A carteira com que você entrou não assina na ${chain}.`,
      off: (chain: string) => `${chain} está indisponível no nosso servidor por enquanto.`,
      saving: 'Trocando…',
      done: (chain: string) => `Agora você está na ${chain}.`,
    },
    is: {
      picked: (chain: string) =>
        `Planos novos são montados na ${chain}. Você pode trocar de rede pela barra no topo.`,
      wallet: (chain: string) =>
        `Planos novos são montados na ${chain}, a rede da carteira que você conectou.`,
    },
    failure: {
      noWallet: (chain: string) =>
        `Não consegui trocar: a carteira com que você entrou não assina na ${chain}.`,
      notOffered: 'Essa rede não pode ser escolhida aqui.',
      unreachable:
        'Não consegui trocar: nosso servidor não respondeu. Você continua na mesma rede. Tente de novo.',
      signedOut: 'Sua sessão expirou antes de a troca ser salva. Entre de novo e troque.',
      noIdentity:
        'Não consegui trocar: o serviço de login não me entregou a parte do seu login que lista suas carteiras, então nosso servidor não consegue conferi-las. Espere um minuto e tente de novo.',
    },
    unknown: {
      off: 'Todas as redes em que suas carteiras assinam estão indisponíveis no nosso servidor por enquanto. Nada foi perdido: volte mais tarde.',
      refused:
        'Nosso servidor não aceitou uma rede para as carteiras com que você entrou, então ainda não consigo montar para você. Saia e entre de novo.',
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
      source: 'os limites do próprio exemplo',
    },
    filledFromWords: 'preenchido a partir das suas palavras',
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
      countryFromBrowser:
        'Tirado do idioma deste navegador. Mude se você mora em outro país: ele define quais ativos você pode ter.',
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
      note: 'A rede em que você está. O plano, o cofre dele e todas as operações ficam nela, mesmo se você trocar depois.',
      unset: 'Não definida',
      unsetNote: 'Um plano é montado na rede em que você está.',
      choose: 'Escolher a rede',
      unknown: 'Ainda não sei',
    },
    blocked: {
      signedOut: 'Entre para montar: um plano é montado para a rede da sua carteira.',
      chainNotChosen: 'Escolha primeiro uma rede na barra no topo.',
      chainUnknown:
        'Ainda não sei em qual rede seu plano fica, então não consigo montar para ela. Pergunte de novo, acima.',
      refused: 'Nosso servidor não aceitou esses limites. Confira cada campo e tente de novo.',
      currency:
        'Os planos são em dólares por enquanto: o valor e cada saque. Informe-os em dólares e monte de novo.',
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
      sentenceIncome: (income: string, amount: string, months: string) =>
        `Gerar ${income} por mês com ${amount} por ${months}.`,
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

  activity: {
    notAdvice: 'Aviso legal',
    title: 'O que foi feito',
    status: {
      built: 'montada',
      signed: 'assinada',
      sent: 'enviada',
      confirmed: 'confirmada',
      failed: 'falhou',
    },
    unknownStatus: 'situação desconhecida',
    notRetried: '(não repetida)',
    signature: 'id da transação',
    noneYet: 'Nada desta ordem chegou à rede ainda.',
    noneVault:
      'Nada das suas compras chegou à rede ainda. As operações do agente, e as ordens sobre um portfólio compartilhado feitas em outro navegador, ainda não aparecem aqui.',
  },
  pin: {
    sourceFor: 'Fonte de {value}',
    staleSuffix: ', desatualizado, {age}',
    mockSuffix: ', número de exemplo',
    stale: 'desatualizado',
    ageUnknown: 'idade desconhecida',
    age: {
      said: 'há {n} {unit}',
      minute: ['minuto', 'minutos'],
      hour: ['hora', 'horas'],
      day: ['dia', 'dias'],
    },
    missing: 'ainda sem fonte',
    provenance: 'Procedência',
    copy: 'Copiar fonte',
    copied: 'Copiado',
    kinds: {
      mock: 'dados de exemplo, não reais',
      sandbox: 'rede de teste, não real',
      fixture: 'dados fixos, não reais',
      prior_dataset: 'dados anteriores, não reais',
    },
    unknownKind: 'não real',
  },

  portfolio: {
    chainOut: (chain: string) => `${chain} está indisponível agora.`,
    chainOff: (chain: string) => `${chain} está indisponível no nosso servidor por enquanto.`,
    notHeld: (chain: string) => `${chain} não está nesta conta.`,
    title: (vaults: number) =>
      vaults > 1 ? 'O que seus cofres guardam.' : 'O que seu cofre guarda.',
    lead: 'Lido de cada rede onde seus planos ficam, cada vez que você abre esta página. Nada aqui assina ou move coisa alguma.',
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
    group: {
      worth: (vaults: number, chain: string) =>
        vaults > 1 ? `Seus ${vaults} cofres na ${chain} valem` : `Seu cofre na ${chain} vale`,
      method: (vaults: number, chain: string) =>
        `seus ${vaults} cofres na ${chain}, cada um avaliado como mostrado, somados`,
      across: (chains: number) =>
        chains === 2 ? 'Nas duas redes, juntas' : `Nas ${chains} redes, juntas`,
      acrossMethod: (chains: number) => `os totais das ${chains} redes acima, somados`,
    },
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
      chips: { label: 'O cofre', address: 'endereço', version: 'versão', follow: 'seguir' },
      parts: 'As partes, por peso',
      planTitle: (parts: number) =>
        parts === 1 ? 'Seu plano · 1 parte' : `Seu plano · ${parts} partes`,
      tooMany: 'Mais partes do que uma barra mostra: cada uma está na tabela abaixo.',
      target: (share: string) => `alvo ${share}`,
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
    goalCard: {
      builtMet: 'No caminho quando o plano foi montado',
      builtShort: 'Abaixo da renda quando o plano foi montado',
      builtPaid: (paid: string, asked: string) =>
        `Quando este plano foi montado, ele pagava ${paid} por mês dos ${asked} que você pediu.`,
      noStatus: 'Ainda sem situação: o motor não dá uma para um cofre',
      unknown: (chain: string) => `Seu cofre na ${chain}.`,
      notJoined:
        'Este cofre não tem um objetivo que eu consiga ler: foi comprado a partir de um portfólio compartilhado, que não tem, ou antes de os planos guardarem seu objetivo. O que ele guarda está abaixo.',
      putIn: (amount: string) => `você colocou ${amount}`,
      seePlan: 'Ver seu plano',
      seeOrder: 'Ver a ordem',
      startGoal: 'Comece pelo seu objetivo',
    },
    summary: {
      title: 'Seu portfólio',
      worth: (chain: string) => `Seu cofre na ${chain} vale`,
      many: (vaults: number, chain: string) => `Você tem ${vaults} cofres na ${chain}.`,
      manyChains: (vaults: number, chains: string) => `Você tem ${vaults} cofres, na ${chains}.`,
      see: 'Ver seu portfólio',
    },
  },

  plan: {
    title: 'Seu plano',
    signedOut: 'Entre para ver este plano. Um plano é de uma pessoa, na rede da carteira dela.',
    fromLink:
      'Este plano veio de um link: nosso motor o montou com os limites que o link trazia, que outra pessoa pode ter definido. Confira o objetivo, o valor e os limites acima antes de comprar.',
    missing: {
      title: 'Não encontro este plano para você.',
      body: 'Não é um plano feito com este login, ou não está mais guardado. Monte um a partir do seu objetivo: seus limites continuam guardados.',
    },
    backToGoal: 'Voltar ao seu objetivo',
    unsignable: (plan: string) =>
      `Este plano está na ${plan}, e a carteira com que você entrou não assina nela. Entre com uma carteira que assine, ou monte um plano a partir do seu objetivo.`,
    split:
      'Este plano está dividido entre duas redes, e um plano fica em uma só. Monte de novo a partir do seu objetivo.',
    lead: (chain: string) =>
      `Montado para ${chain}, a partir dos seus limites. Nada é comprado antes de você revisar cada passo e assinar.`,
    holds: 'O que ele tem',
    cash: (token: string) => `Dinheiro (${token})`,
    summary: {
      head: (amount: string, months: string, risk: string, chain: string) =>
        `${amount} por ${months}, ${risk}, na ${chain}:`,
      headOpen: (amount: string, risk: string, chain: string) =>
        `${amount} sem data, ${risk}, na ${chain}:`,
      stays: (amount: string, name: string) => `${amount} fica em ${name}`,
      goes: (amount: string, name: string) => `${amount} vai para ${name}`,
      more: (n: number) => (n === 1 ? 'mais uma parte' : `mais ${n} partes`),
    },
    badFall: {
      none: 'Numa queda forte: você perderia cerca de US$ 0, pois nada aqui é ação, cripto ou ouro.',
      some: (amount: string) =>
        `Numa queda forte: você perderia cerca de ${amount}, uma estimativa.`,
    },
    details: 'Detalhes',
    leftOut: 'Ficou de fora deste plano',
    kinds: {
      stock: 'Ações',
      etf: 'Fundos',
      gold: 'Ouro',
      commodity: 'Commodities',
      dollar_yield: 'Rendimento em dólar',
      crypto: 'Cripto',
      cash: 'Dinheiro',
      other: 'Outros',
    },
    flagWords: {
      ceilingFromTier: (asset: string) =>
        `Quanto ${asset} pode pesar vem da faixa dele, pois o custo de venda ainda não foi medido.`,
      coverageFromTier: (asset: string) =>
        `${asset} conta para os seus saques pelo limite da faixa dele, pois o custo de venda ainda não foi medido.`,
      capacityThin: (asset: string) =>
        `${asset} só vende barato em valores pequenos, então o plano tem menos dele.`,
      regimeNotMeasured: (asset: string) =>
        `A venda de ${asset} em alguns horários da semana ainda não foi medida, e pode custar mais.`,
      undated: (asset: string) =>
        `O custo de venda medido para ${asset} não tem data, então não é usado.`,
      fxOpen: (currency: string) =>
        `Parte do que você deve em ${currency} não está em ${currency}, então uma mudança no câmbio pode custar a você.`,
      noMatchingLeg: (currency: string) =>
        `O plano não tem nada em ${currency} para pagar os saques nessa moeda.`,
      noFx: (currency: string) =>
        `Ainda não há câmbio para ${currency}, então os saques nessa moeda não são contados.`,
      noQuote: 'Ainda não há cotação recente para vender tudo.',
      withdrawalsShort: 'Nem todo saque é pago em dia com o que está separado.',
      notLive:
        'Alguns números vêm de uma rede de teste ou de dados de exemplo, não de mercados ao vivo.',
      other: 'O motor anotou mais uma coisa sobre este plano.',
      simple: {
        exit_not_measured: 'Nenhuma parte deste plano tem custo de venda medido ainda.',
        exit_partly_measured: 'Só parte deste plano tem custo de venda medido.',
        exit_beyond_measured_size:
          'Parte deste plano é maior que a maior venda medida, então vendê-la pode custar mais.',
        exit_capacity_short:
          'Parte deste plano é maior do que se vende por 1% ou menos no pior horário medido.',
        exit_cost_below_zero: 'Um custo de venda medido saiu abaixo de zero, e conta como zero.',
        exit_regimes_not_reported:
          'O custo de venda não é informado para todos os horários da semana.',
        issuer_concentration: 'Mais da metade do plano está com um só emissor.',
        asset_not_on_shelf:
          'Uma parte do plano não está na lista de ativos, então não pôde ser classificada.',
        unplaced: 'Parte do dinheiro não coube nos seus limites, e fica em dinheiro.',
        no_dollar_yield:
          'Não há rendimento em dólar que você possa ter aqui, então o resto fica em dinheiro.',
        safe_yield_no_rate_leg:
          'Não há aqui um token que pague só uma taxa, então a parte segura fica em dinheiro.',
        yield_not_read: 'Ainda não há leitura de rendimento, então nenhuma projeção é mostrada.',
        liquidity_unsourced: 'Um custo de venda sem fonte não é usado.',
        coverage_moved: 'Dinheiro foi movido para que os seus saques sejam pagos em dia.',
        obligations_past: 'Um saque com data no passado ficou de fora.',
        income_not_estimated: 'A renda que este plano paga ainda não foi estimada.',
        income_no_amount_closes: 'Nenhum valor maior paga a renda que você pediu.',
      },
    },
    short: (months: string) => `Em ${months}:`,
    shortRange: (low: string, high: string) => `cerca de ${low} a ${high}`,
    sub: (risk: string, chain: string) => `${risk} · em ${chain} · nada comprado ainda`,
    riskWord: { low: 'Risco baixo', medium: 'Risco médio', high: 'Risco alto' },
    chips: {
      label: 'Seus limites',
      goal: 'objetivo',
      amount: 'valor',
      horizon: 'prazo',
      risk: 'risco',
      riskValue: { low: 'baixo', medium: 'médio', high: 'alto' },
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
    chart: {
      label: (months: number, low: string, high: string) =>
        `O que o rendimento em dólar projeta em ${months} meses: de ${low} a ${high} ao ano.`,
      after: (months: number) => `Depois de ${months} meses`,
      paid: (months: number) => `Pago ao longo de ${months} meses, ao todo`,
      projected: 'projetado',
      low: 'ponta baixa',
      high: 'ponta alta',
      note: 'Só o que o rendimento em dólar paga é projetado. Os preços de ações e ouro não são, e podem cair.',
      table: 'A projeção',
      month: (m: number) => `mês ${m}`,
      hint: 'Aponte para o gráfico, toque nele ou use as setas para ler um mês.',
      series: 'O que o gráfico mostra',
    },
    exitPlan: 'Plano de saída',
    costPrefix: 'custo',
    columns: { asset: 'Ativo', share: 'Parte', amount: 'Valor', why: 'Por quê' },
    noReason: 'Nenhum motivo informado.',
    projected: 'Faixa projetada por ano, não é uma promessa',
    projectedValue: (low: string, high: string) => `${low} a ${high}`,
    basis: (basis: string) => `Como foi calculada: ${String(basis).replace(/[.\s]+$/, '')}.`,
    lossInFall: (amount: string) =>
      `Numa queda forte, o motor conta uma perda de cerca de ${amount} neste plano.`,
    exitUnmeasured: 'Ainda não foi medido, então nenhum custo é mostrado.',
    exitCost: (cost: string) => `≤ ${cost}`,
    inKind: 'Você também pode tirar os próprios tokens do seu cofre a qualquer momento.',
    risk: {
      notKept:
        'Como este plano se divide, e quanto custa vendê-lo, é calculado quando um plano é montado e não fica guardado com ele. Monte o plano de novo a partir do seu objetivo para ver.',
      title: 'Como o plano se divide, e quanto custa vender',
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
    short: {
      title: 'No que você confia',
      unaudited: 'O código dos cofres não foi auditado fora da equipe.',
      keys: 'A equipe tem chaves que podem atualizar o código dos cofres.',
      keeper: (tolerance: string, loss: string) =>
        `Com o seguir automático ativado, nosso operador negocia dentro de limites: no máximo ${tolerance} longe do preço de referência, e no máximo ${loss} do seu cofre perdido numa semana.`,
      keeperUnset:
        'Os limites do operador não estão definidos nesta rede, então o seguir automático não é oferecido aqui.',
      issuers: 'Os emissores de tokens de ações podem congelar ou retomar seus tokens.',
      full: 'Ler a lista completa',
    },
  },

  buy: {
    title: 'Comprar seu plano',
    lead: (chain: string) =>
      `O valor inteiro vai para um cofre de onde só você pode sacar, em ${chain}, e então compra cada ativo do plano.`,
    amount: {
      label: 'Valor (dólares)',
      hint: (planned: string) =>
        `Seu plano foi montado para ${planned}. De US$ 10 a US$ 1.000.000.`,
    },
    steps: {
      label: 'Passos para comprar',
      names: { amount: 'Valor', funds: 'Fundos', trust: 'Confiança', review: 'Assinar' },
      done: 'feito',
      next: 'Continuar',
      funds: { ready: 'Pronto', short: 'Falta algo', reading: 'Lendo…' },
      trust: { accepted: 'Aceito', open: 'Ainda não aceito' },
      reviewLead: (amount: string, chain: string) =>
        `Você está comprando ${amount} do seu plano em ${chain}. Em seguida você revisa cada passo e assina cada um na sua carteira.`,
      note: {
        testNetwork: (chain: string) => `Rede de teste · ${chain} · valores não reais`,
      },
    },
    funding: {
      title: 'O que sua carteira precisa',
      needs: (cash: string, gas: string) => `Você precisa de ${cash} e ${gas} para as taxas.`,
      haveNone: 'Você ainda não tem nada.',
      lacking: (list: string) => `Ainda faltam ${list}.`,
      and: (a: string, b: string) => `${a} e ${b}`,
      details: 'Mostrar os detalhes',
      testFunds: 'Receber fundos de teste',
      testFunding: 'Enviando fundos de teste…',
      testNote: 'Tokens de teste não têm valor. Eles existem só na rede de teste.',
      testSent: (list: string) => `Enviei ${list} para sua carteira na rede de teste.`,
      testFailure: {
        busy: 'Você já recebeu fundos de teste quantas vezes um dia permite. Tente amanhã, ou coloque fundos na carteira você mesmo.',
        tooMuch:
          'Este valor precisa de mais do que um envio de fundos de teste dá. Escolha um valor menor e peça de novo.',
        enough: 'Sua carteira já tem o que esta compra precisa.',
        lowCash:
          'Nossos fundos de teste estão baixos. Peça à equipe para completar, ou coloque fundos na carteira você mesmo.',
        lowGas:
          'Nosso gás de teste está baixo. Peça à equipe para completar, ou coloque fundos na carteira você mesmo.',
        refused:
          'Nosso servidor não enviou fundos de teste para esta compra. Leia sua carteira de novo e tente outra vez.',
        unreachable:
          'A rede de teste não aceitou a transferência, ou nosso servidor não respondeu. Leia sua carteira de novo: parte pode ter chegado.',
      },
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
      mockFund: 'Adicionar dinheiro e taxas de exemplo',
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
      funding: 'Sua carteira precisa do que falta antes de você continuar.',
      trust: 'Aceite o aviso para continuar.',
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

  shared: {
    meta: {
      shelf: 'Portfólios compartilhados',
      family: 'Portfólio compartilhado',
      familyDescription: 'Uma lista de ativos e pesos que quem a criou publicou numa rede.',
      publish: 'Publicar um portfólio',
      publishDescription: 'Publique sua lista de ativos e pesos para outras pessoas seguirem.',
      vault: 'Cofre',
    },
    shelf: {
      title: 'Portfólios que as pessoas compartilharam.',
      lead: (chain: string) =>
        `Cada um é uma lista de ativos e pesos que quem o criou publicou numa rede. Estes são os da ${chain}, onde ficam seus planos.`,
      leadAll:
        'Cada um é uma lista de ativos e pesos que quem o criou publicou numa rede. Entre para ver os da sua rede.',
      loading: 'Lendo os portfólios compartilhados…',
      empty: (chain: string) => `Nenhum portfólio foi compartilhado na ${chain} ainda.`,
      emptyAll: 'Nenhum portfólio foi compartilhado ainda.',
      publish: 'Publicar um portfólio',
      card: {
        by: (creator: string) => `por ${creator}`,
        platform: 'Da tenonfi',
        version: (n: number) => `versão ${n}`,
        waiting: (n: number) => `versão ${n} aguarda`,
        open: (name: string) => `Abrir ${name}`,
        on: 'na',
      },
      failure: {
        unreachable:
          'Não consegui ler os portfólios compartilhados: nosso servidor não respondeu. Tente de novo.',
        unreadable:
          'Nosso servidor respondeu com algo que não consegui ler, então não vou mostrar.',
        retry: 'Ler de novo',
      },
    },
    text: {
      unverified:
        'O nome e a descrição não batem com o que quem criou publicou na rede, então não posso garantir que sejam dele.',
      pending:
        'O nome e a descrição são os da versão que aguarda. A versão em vigor foi publicada com outras palavras.',
      creator: 'Criado por',
      notChecked:
        'O nome e a descrição não foram conferidos com o que quem criou publicou na rede.',
    },
    family: {
      loading: 'Lendo este portfólio…',
      missing: 'Não encontro um portfólio compartilhado com esse nome.',
      backToShelf: 'Voltar aos portfólios compartilhados',
      lead: (chain: string) =>
        `Uma lista de ativos e pesos que quem a criou publicou na ${chain}. Segui-la quer dizer que um cofre seu assume esses pesos; uma versão nova entra em vigor depois de um prazo, e você a vê antes disso.`,
      notHere: (chain: string) =>
        `Este portfólio não está publicado na ${chain}, sua rede atual, então não dá para segui-lo daqui.`,
      elsewhere: (chain: string) =>
        `Você tem um cofre na ${chain} que segue este portfólio. Troque para a ${chain} para atualizá-lo lá.`,
      switchTo: (chain: string) => `Trocar para a ${chain}`,
      recipe: (chain: string) => `Na ${chain}`,
      inEffect: 'Em vigor',
      since: (when: string) => `desde ${when}`,
      waits: (n: number, when: string) => `A versão ${n} entra em vigor em ${when}`,
      waitsLead:
        'Ela foi publicada e ainda não está em vigor. Um cofre que segue este portfólio só passa para ela quando estiver.',
      versionN: (n: number) => `Versão ${n}`,
      versions: 'Todas as versões',
      columns: { version: 'Versão', status: 'Situação', effective: 'Em vigor a partir de' },
      status: {
        active: 'Em vigor',
        pending: 'Aguardando',
        superseded: 'Substituída',
        cancelled: 'Retirada',
      },
      buy: 'Comprar e seguir este portfólio',
      signIn: 'Entre para seguir',
      chainNotReady: (chain: string) =>
        `A ${chain} ainda não está pronta para seguir portfólios: os cofres dela não estão implantados nesta rede.`,
      tampered: (chain: string) =>
        `Não consegui verificar este portfólio na ${chain}, então não vou oferecer comprá-lo nem segui-lo: ele pode ter sido adulterado. Tente mais tarde.`,
      missingOnChain: (chain: string) =>
        `A ${chain} não tem esse portfólio: li a rede, e o registro não o tem. Não dá para segui-lo.`,
      unlisted:
        'A versão na rede tem um token que este app não lista, então não vou oferecer seguir.',
      notListed: 'um token que este app não lista',
      foreign:
        'Este portfólio não foi publicado por este app, então não consigo conferir o identificador dele pelo nome, e seguir ainda não é oferecido aqui.',
    },
    check: {
      reading: 'Lendo da rede…',
      read: (chain: string) =>
        `Lido da ${chain} por este app, não do nosso servidor: a versão e os pesos mostrados são os da rede.`,
      differs: (chain: string) =>
        `A resposta do nosso servidor difere do que a ${chain} tem. Mostro a versão e os pesos da rede, e seguir fica preso a eles.`,
      unverified: {
        mock: 'Rede de exemplo: não há rede para ler, então estas são palavras do nosso servidor, não conferidas.',
        'no-node': (chain: string) =>
          `Não conferido na ${chain}: este app não tem um nó próprio para ler. Estas são palavras do nosso servidor.`,
        'no-deployment': (chain: string) =>
          `Não conferido na ${chain}: este app não tem registro dos tokens nesta rede. Estas são palavras do nosso servidor.`,
        'family-id':
          'Não conferido na rede: este portfólio não foi publicado por este app, então o identificador dele vem do nosso servidor. Estas são palavras do nosso servidor.',
      },
      failed: (chain: string) =>
        `Não consegui verificar este portfólio na ${chain}: o nó de onde este app lê não respondeu, ou o que nosso servidor indicou não é o portfólio que a rede tem. Ele pode ter sido adulterado, então não vou oferecer segui-lo.`,
      missing: (chain: string) =>
        `Li a ${chain}, e ela não tem este portfólio: o que aparece é só a palavra do nosso servidor.`,
      verified: 'Lido da rede',
      notChecked: 'Não conferido na rede',
    },
    offer: {
      title: 'Seguir automático',
      offered:
        'Oferecido: com o seguir automático ativado, nosso operador rebalanceia um cofre que segue este portfólio quando uma versão nova entra em vigor, dentro dos limites do cofre.',
      noOracle: (assets: string, chain: string) =>
        `Não oferecido: este portfólio tem ${assets}, que não tem oráculo de preço na ${chain}, então nosso operador não consegue rebalanceá-lo. Se você segui-lo, peço que rebalanceie, com um toque, quando ele mudar.`,
      switchedOff: (chain: string) =>
        `Ainda não oferecido na ${chain}: nosso operador não roda lá. Se você segui-lo, peço que rebalanceie, com um toque, quando ele mudar.`,
    },
    buy: {
      title: 'Comprar e seguir',
      lead: (chain: string) =>
        `Um cofre seu na ${chain} segue este portfólio, na versão mostrada, com o seguir automático desativado. Nada é comprado até você revisar cada passo e assinar.`,
      amountHint: 'Em dólares, a partir de US$ 10.',
      review: (amount: string) => `Revisar a compra de ${amount}`,
      blocked: {
        terms: 'Não consegui ler este portfólio, então ainda não há o que seguir.',
        missing: 'A rede não tem este portfólio, então não dá para segui-lo.',
        unlisted: 'Este portfólio tem um token que este app não lista.',
      },
    },
    vaults: {
      title: 'Seus cofres',
      none: 'Você ainda não tem um cofre nesta rede. Compre este portfólio para abrir um que o segue.',
      following: 'Segue este portfólio',
      notFollowing: 'Segue outra coisa',
      followWith: 'Seguir com este cofre',
      followNote:
        'Seu cofre assume os pesos deste portfólio. Nada é negociado nesse passo: você rebalanceia depois, ou o operador faz isso com o seguir automático ativado.',
      autoOn: 'Ativar o seguir automático',
      autoOff: 'Desativar o seguir automático',
      autoIs: (on: boolean): string =>
        on ? 'O seguir automático está ativado.' : 'O seguir automático está desativado.',
      oneTap:
        'Este portfólio não é rebalanceado automaticamente. Quando ele mudar, peço aqui que você aceite a versão nova e rebalanceie.',
      address: (address: string) => `Cofre ${address}`,
      open: 'Abrir o cofre',
      failure: 'Não consegui ler seus cofres: nosso servidor não respondeu. Tente de novo.',
    },
    prompt: {
      title: 'Este portfólio mudou',
      waits: (n: number, when: string) =>
        `A versão ${n} entra em vigor em ${when}. Você pode aceitá-la então; até lá, seu cofre fica com a versão que tem.`,
      inEffect: (n: number) =>
        `A versão ${n} está em vigor, e seu cofre ainda tem uma anterior. Aceite-a para assumir os pesos dela e depois rebalanceie.`,
      newAssets: (assets: string) => `Ela inclui ${assets}, que seu cofre ainda não tem.`,
      accept: (n: number) => `Aceitar a versão ${n}`,
    },
    publish: {
      title: 'Publicar um portfólio.',
      lead: (chain: string) =>
        `Sua lista de ativos e pesos, com um nome, na ${chain}. Qualquer pessoa pode vê-la e segui-la. Você assina com a sua carteira: confiro a transação com este formulário antes de pedir à carteira.`,
      signIn: 'Entre para publicar um portfólio.',
      about: 'Nome e descrição',
      name: 'Nome',
      nameHint: 'Letras, números e pontuação simples, até 280 caracteres.',
      slug: 'Endereço na prateleira',
      slugHint: 'Letras minúsculas, números e hífens. Não muda depois de publicado.',
      copy: 'Descrição',
      copyHint: 'Até 280 caracteres, sem link.',
      familyId: 'O identificador dele, calculado a partir do endereço',
      assets: 'Ativos e pesos',
      assetsHint: 'De 3 a 12 ativos, cada um de 2% a 50%, em passos de 0,5%, somando 100%.',
      asset: 'Ativo',
      weight: 'Peso, em %',
      add: 'Incluir um ativo',
      remove: (asset: string) => `Tirar ${asset}`,
      total: (sum: string) => `Total: ${sum}`,
      update: (n: number) =>
        `Você já publicou este portfólio. Esta é a versão ${n}: ela entra em vigor depois do prazo de publicação, e uma versão muda no máximo 20% do portfólio.`,
      first: 'Esta é a versão 1: ela entra em vigor assim que chegar à rede.',
      theirs: 'Este endereço é de um portfólio de outra pessoa. Escolha outro.',
      review: 'Revisar a publicação',
      reviewing: 'Criando a ordem…',
      problems: {
        name: 'Um nome precisa de letras, números e pontuação simples, sem espaço nas pontas e sem link ou endereço web.',
        slug: 'Um endereço precisa de letras minúsculas, números e hífens.',
        copy: 'Uma descrição tem no máximo 280 caracteres, sem link ou endereço web e sem caracteres ocultos.',
        count: 'Um portfólio tem de 3 a 12 ativos.',
        weight: 'Cada peso vai de 2% a 50%, em passos de 0,5%.',
        sum: 'Os pesos somam 100%.',
        twice: 'Um ativo aparece uma vez só.',
        chain: 'Por enquanto, publicar só funciona na Solana.',
      },
      failure: {
        said: (error: string) => `Nosso servidor recusou: ${error}.`,
        unreachable: 'Não consegui criar a ordem: nosso servidor não respondeu. Tente de novo.',
        unreadable:
          'Nosso servidor respondeu com uma ordem que não consegui ler, então não vou mostrar.',
        signedOut: 'Sua sessão expirou. Entre de novo, e o formulário fica guardado.',
        noStore:
          'Este navegador não guarda nada entre as páginas, então não vou criar a ordem: um passo poderia ser assinado duas vezes.',
      },
    },
    vault: {
      title: 'Um cofre, como a rede o tem',
      lead: (chain: string) =>
        `Lido da ${chain} para esta página. Qualquer pessoa pode ver um cofre: o que ele tem é público na rede.`,
      loading: 'Lendo o cofre…',
      missing: 'Não há cofre neste endereço.',
      owner: 'Dono',
      follows: 'Segue',
      followsNothing: 'Nada: quem é dono define os pesos',
      version: (n: number) => `versão ${n}`,
      autoFollow: 'Seguir automático',
      value: 'Valor',
      cash: 'Dinheiro',
      columns: {
        asset: 'Ativo',
        held: 'Quantidade',
        price: 'Preço',
        weight: 'Peso',
        target: 'Alvo',
        drift: 'Desvio',
      },
      on: 'Ativado',
      off: 'Desativado',
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
      trades:
        'Esta ordem gasta seu depósito com outros pesos que não os do portfólio que você revisou, então não vou oferecer a assinatura. Nada foi assinado. Crie uma nova ordem.',
      shape:
        'Esta ordem tem passos que o portfólio que você revisou não pede, então não vou oferecer a assinatura. Nada foi assinado. Crie uma nova ordem.',
    },
    shared: {
      publishTitle: 'O que você publica',
      followTitle: 'O que você segue',
      name: 'Nome',
      slug: 'Endereço na prateleira',
      copy: 'Descrição',
      noCopy: 'Sem descrição.',
      version: 'Versão',
      first: 'Versão 1, em vigor assim que chegar à rede',
      next: (n: number) => `Versão ${n}, em vigor depois do prazo de publicação`,
      versionN: (n: number) => `Versão ${n}`,
      familyId: 'Identificador',
      onchain: 'Na rede',
      vault: 'Seu cofre',
      autoFollow: 'Seguir automático',
      on: 'Ativado',
      off: 'Desativado',
      weights: 'Ativos e pesos',
      publishNote:
        'Sua carteira só é chamada para assinar uma transação que publique exatamente este nome, esta descrição e estes pesos, com este identificador.',
      signPublish: 'Assinar e publicar',
      signFollow: 'Assinar e seguir',
      resume: 'Continuar',
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
      planGone:
        'O plano desta ordem não está mais guardado: um plano vindo de um link que ninguém compra é apagado depois de alguns dias. A ordem parou, e o que foi assinado fica guardado. Monte o plano de novo a partir do seu objetivo.',
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
          'O plano guardado para esta ordem não confere com ela (outra rede ou outro cofre), então nada foi assinado. Crie uma nova ordem.',
      },
      crashed: 'Algo parou a ordem antes do fim. O que foi assinado fica guardado. Tente de novo.',
      newOrder: 'Criar uma nova ordem',
    },
  },
  landing: {
    title: 'Objetivos, cortados sob medida',
    description:
      'Diga o que o seu dinheiro precisa fazer. A tenonfi monta o portfólio que leva até lá e mostra como.',
    nav: {
      home: 'tenonfi, início',
      main: 'Principal',
      menu: 'Menu',
      skip: 'Pular para o conteúdo',
      products: 'Produtos',
      invest: 'Investir',
      resources: 'Recursos',
      analytics: 'Análises',
      cta: 'Entrar',
      openApp: 'Abrir o app',
    },
    stage: {
      label: 'Como a tenonfi encaixa',
      title:
        'Nenhum produto serve para todo mundo. Então fazemos as peças\u00a0— e os seus objetivos decidem como elas se encaixam.',
      taglineStrong: 'Sob medida. Cada encaixe à vista.',
      tagline:
        'Diga o que o seu dinheiro precisa fazer. A tenonfi monta o portfólio que leva até lá e mostra como.',
      cue: 'Role para ver o encaixe',
      drawing:
        'O plano, cortado sob medida, atravessa o objetivo e assenta; o pino entra por último.',
      steps: [
        {
          n: '01 · As peças',
          title: 'Nós cortamos as peças.',
          body: 'Rendimento em dólar, títulos do Tesouro americano, crédito, caixa: cada um medido pelo que paga de verdade depois do risco, e pela rapidez com que volta a ser dólar.',
        },
        {
          n: '02 · O encaixe',
          title: 'O seu objetivo decide como elas se encaixam.',
          body: 'Um valor, uma data, o dinheiro que você precisa poder alcançar. O plano é cortado nesses limites e em nenhum outro.',
        },
        {
          n: '03 · O pino',
          title: 'Cada encaixe fica à vista.',
          body: 'Cada número traz a sua fonte. Cada portfólio tem um plano de saída antes de o agente investir.',
        },
      ],
    },
    show: {
      label: 'Dois objetivos, dois cortes',
      eyebrow: 'Dois objetivos, dois cortes',
      title: 'As mesmas peças. Pessoas diferentes. Encaixes diferentes.',
      lead: 'Como fica um plano quando ele parte de uma vida, não de uma lista de produtos. Planos de exemplo: todo número abaixo é ilustrativo.',
      sample: 'taxas de exemplo, não reais',
      estimate: 'estimativa',
      sampleUnit: 'exemplo',
      perMonth: '/ mês',
      chips: 'Os limites',
      legs: 'Como as peças se encaixam',
      chartTable: 'O gráfico em tabela',
      readout: {
        hint: 'Aponte para o gráfico, toque nele ou use as setas para ler um mês.',
        series: 'O que o gráfico mostra',
        putIn: 'aportado',
        paidOut: 'pago',
        base: 'cenário base',
        range: 'do cenário fraco ao forte',
        weak: 'cenário fraco',
        strong: 'cenário forte',
        goal: 'alvo',
      },
      month: 'Mês',
      balance: 'Saldo',
      exitPlan: 'Plano de saída antes de investir',
      trip: {
        label: 'Exemplo: uma viagem em 2029',
        alt: 'O plano da Mariana desenhado como um encaixe, suas partes empilhadas num só pilar, cada uma da altura da sua parcela.',
        who: (cash: string) => `Mariana · 31 · recebe em ${cash}`,
        quote:
          'Quero uma reserva que eu possa acessar a qualquer dia e que me pague US$ 1.000 por mês durante uma viagem de três meses em 2029.',
        title: 'Reserva da viagem · jan–mar 2029',
        sub: 'Risco baixo · acessível em 1 dia · renda, então sem ações',
        chips: [
          'alvo: US$ 1.000/mês × 3',
          'prazo: 27 meses',
          'liquidez: 1 dia',
          'risco de crédito: nenhum',
        ],
        kpis: {
          save: 'você guarda',
          for: 'por',
          earned: 'ganho a mais',
          odds: 'chance de chegar lá',
        },
        months: (n: number) => `${n} meses`,
        chart:
          'Saldo mensal por parte, crescendo até janeiro de 2029 e depois pagando US$ 1.000 por mês durante três meses.',
        payout: 'viagem: US$ 1.000/mês × 3 →',
        legs: [
          {
            name: (cash: string) => `Reserva em caixa (${cash})`,
            why: 'paga primeiro os meses da viagem',
          },
          {
            name: () => 'Títulos do Tesouro tokenizados',
            why: 'rendimento em dólar, resgate no dia seguinte',
          },
          { name: () => 'Empréstimo em dólar', why: 'taxa variável, saque imediato' },
        ],
        exit: 'o saldo inteiro fica acessível em até um dia; os meses da viagem saem primeiro da reserva em caixa.',
        exitNote: 'Com fonte real depois que você conectar.',
      },
      growth: {
        label: 'Exemplo: um objetivo de crescimento com mais risco',
        alt: 'O plano do Diego desenhado como um encaixe, suas partes empilhadas num só pilar, cada uma da altura da sua parcela.',
        who: 'Diego · 38 · nativo de cripto',
        quote:
          'Transformar US$ 20.000 em US$ 35.000 até 2031 para uma temporada nas montanhas. Aguento uma queda de 25% no caminho.',
        title: 'Temporada nas montanhas · até dez 2031',
        sub: 'Risco mais alto · crescimento · ações permitidas · saídas medidas pela Bearing',
        chips: [
          'início: US$ 20.000',
          'alvo: US$ 35.000',
          'queda máxima: 25%',
          'risco de crédito: aceito',
        ],
        kpis: {
          add: 'você aporta',
          base: 'cenário base',
          odds: 'chance de US$ 35 mil',
          drop: 'queda tolerada',
        },
        maxUnit: 'máx.',
        chart:
          'Saldo projetado até 2031, com um caminho base e uma faixa do cenário fraco ao forte, contra o alvo de US$ 35.000.',
        goalLine: 'alvo US$ 35 mil',
        legs: [
          { name: () => 'Títulos do Tesouro tokenizados', why: 'lastro e a primeira saída' },
          {
            name: () => 'Crédito privado',
            why: 'rendimento maior, saída mais lenta (risco de crédito aceito)',
          },
          {
            name: (stocks: string) => `Ações tokenizadas (${stocks})`,
            why: 'crescimento, no tamanho que a Bearing mede para vender',
          },
          { name: () => 'Ouro tokenizado', why: 'diversifica, sem rendimento' },
        ],
        exit: 'as ações têm o tamanho que a Bearing mede que dá para vender na hora mais rasa da semana.',
        exitNote: 'No fim de semana, sair é mais lento e custa mais.',
        oddsNote: 'As chances são estimativas.',
      },
    },
    sim: {
      label: 'Teste o seu objetivo',
      eyebrow: 'Teste · sem carteira',
      title: 'Diga o que o seu dinheiro precisa fazer.',
      lead: 'Descreva um objetivo com as suas palavras. Você vê como ele é lido e como as peças se encaixariam, antes de conectar qualquer coisa.',
      examples: [
        'US$ 40.000 até junho de 2028, dinheiro em até 7 dias',
        'US$ 3.000 por mês a partir de 2028',
        'Fazer US$ 25.000 crescerem em 3 anos, aceito risco de crédito',
      ],
      opening: 'Abrindo o seu objetivo…',
    },
    closing: {
      label: 'Acompanhe',
      eyebrow: 'Acompanhe',
      title: 'Construído peça por peça. Veja tomar forma.',
      lede: 'Novidades do produto a cada peça cortada, e uma carta curta sobre objetivos, liquidez e o que os ativos tokenizados pagam de verdade. Sem hype, sem palpite de preço.',
      drawingAlt:
        'Dez moedas, cada uma um ativo que um plano pode ter, de ações e ouro a títulos do Tesouro tokenizados, se juntando uma a uma num só plano, cada uma do tamanho da sua parte.',
      coins: {
        line: 'Um plano, dez peças, um cofre.',
        sample: 'Partes de exemplo, só para ilustrar.',
        parts: 'As partes do plano de exemplo',
      },
      email: 'E-mail',
      subscribe: 'Inscrever',
      subscribing: 'Inscrevendo…',
      group: 'O que receber',
      updates: 'Novidades do produto',
      newsletter: 'Carta',
      status: {
        rest: 'As inscrições ainda não abriram: nada do que você digitar aqui é enviado ou guardado.',
        'invalid-email': 'Esse e-mail parece incompleto. Confira o @ e o domínio.',
        'no-option': 'Escolha pelo menos um: novidades do produto ou a carta.',
        submitting: 'Inscrevendo…',
        success:
          'Nada foi enviado: as inscrições ainda não abriram, e o seu e-mail não foi guardado.',
        already: 'Você já está na lista.',
        error: 'Não conseguimos guardar isso agora. Tente de novo em um minuto.',
      },
    },
    foot: 'Os planos, taxas e chances desta página são dados de exemplo. Nenhum deles é real.',
  },

  embed: {
    label: 'Plano pela tenonfi',
    eyebrow: 'Seu objetivo, lido pela tenonfi',
    title: 'O que o seu dinheiro precisa fazer?',
    lead: 'Diga em uma frase. Eu transformo em limites; o plano é montado na tenonfi, numa carteira sua.',
    box: 'Seu objetivo',
    placeholder: 'US$ 10.000 por cinco anos, risco médio',
    read: 'Ler meu objetivo',
    reading: 'Lendo seu objetivo…',
    unread: 'Seu objetivo, como foi lido',
    limits: 'Como eu li',
    notFound: 'não encontrado: você define na tenonfi',
    build: 'Montar este plano na tenonfi',
    buildNote:
      'Abre a tenonfi em uma nova aba, onde você entra com uma carteira sua. Nada é assinado aqui.',
    readFailure: 'Não consegui ler isso agora. Seu texto continua aqui. Tente de novo.',
    tooShort: 'Isso é curto demais para eu ler. Tente um valor e um prazo.',
    poweredBy: 'Feito com',
    loading: 'Carregando o plano…',
    unavailable: 'Este plano não está disponível.',
    showSchedule: 'Mostrar o cronograma',
    vault: {
      title: (chain: string) => `Seu cofre na ${chain}`,
      lead: 'O que ele guarda agora, lido da rede.',
      value: 'Valor',
      parts: 'As partes',
      see: 'Ver na tenonfi',
    },
  },
};
