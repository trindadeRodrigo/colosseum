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
    slow: {
      title: 'O login está lento',
      wallets:
        'Você entrou, mas o serviço de login ainda não entregou suas carteiras. Nada foi perdido.',
      server:
        'Você entrou, mas nosso servidor ainda não disse em qual rede fica o seu plano. Nada foi perdido.',
      service:
        'O serviço de login ainda não respondeu, então não sei dizer se você entrou. Você pode continuar olhando.',
      again: 'Tentar de novo',
      trying: 'Tentando de novo…',
      held: 'Um passo da sua ordem está sendo assinado. Conclua ou cancele esse passo primeiro e tente de novo.',
    },
    address: 'Endereço',
    copyAddress: 'Copiar endereço',
    copied: 'Copiado',
    viewOn: (explorer: string) => `Ver no ${explorer}`,
    disclaimer: 'Aviso legal',
    appearance: 'Aparência',
    themes: { auto: 'Sistema', light: 'Claro', dark: 'Escuro' },
    language: 'Idioma',
    testNetwork: 'rede de teste',
    testNetworkLine: 'Rede de teste',
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
      createNewNote:
        'É sua primeira vez? Uma chave de acesso nova abre uma conta nova, com uma carteira nova e vazia. Ela não abre uma carteira que você já tem.',
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
    silent: {
      body: 'O serviço de login ainda não respondeu, então não consigo fazer seu login agora.',
      offline: 'Este aparelho parece estar sem conexão. Confira a conexão e tente de novo.',
      blocked:
        'O serviço de login não respondeu. Um bloqueador pode impedir isso, ou este endereço pode não estar configurado para login.',
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
        'Nenhuma chave de acesso foi usada. Se você criou uma em outro aparelho, use esse aparelho ou escolha “usar um celular” na janela.',
      passkeyUnknown:
        'Não reconheço essa chave de acesso: nenhuma conta aqui foi aberta com ela. Tente a chave com que você se cadastrou.',
      passkeyNotAccepted:
        'Nenhuma chave de acesso deste site foi aceita, então você não entrou. Tente de novo com a chave com que você se cadastrou, no aparelho que a tem.',
      passkeyNotRegistered:
        'Essa chave de acesso não está registrada aqui: ela foi criada para outro site ou aplicativo. Escolha a chave com que você se cadastrou aqui.',
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
      originRefused:
        'O login não está configurado para este endereço: o serviço de login não aceita logins a partir dele. Não há nada para você corrigir. Use o site no endereço dele, ou nos avise.',
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
    explore: {
      invitation: 'O que você quer que sua estratégia faça?',
      lead: 'Conte suas ideias, necessidades e limites. Eu posso discutir uma alocação com fontes e riscos.',
      placeholder: 'Descreva o que quer explorar…',
      starters: [
        'Explorar ações de tecnologia',
        'Criar uma estratégia de renda',
        'Proteger minhas economias',
      ],
      local: 'Este navegador · conversa privada de rascunho',
      signIn: 'Entre para explorar uma estratégia privada.',
      readingAccount: 'Sua conta e rede precisam estar prontas antes de eu buscar uma resposta.',
      empty:
        'A alocação proposta e suas fontes aparecerão aqui após uma resposta. Nenhum cofre foi criado.',
      previewOnly: 'Apenas uma prévia. Este rascunho ainda não pode ser investido aqui.',
      draftNote:
        'Um rascunho desta conversa. Nada é comprado antes de você revisar a mistura e assinar.',
      retry: 'Tentar de novo',
      elsewhere: 'Ver portfólios compartilhados',
      unavailable:
        'O serviço de conversa de estratégia está indisponível. Suas palavras foram mantidas; nenhum rascunho foi produzido.',
      timeout:
        'A resposta demorou demais. Suas palavras foram mantidas; tente novamente em instantes.',
      budget:
        'A conversa atingiu o limite diário de uso. Suas palavras foram mantidas; tente novamente mais tarde.',
      invalid:
        'Não consegui produzir uma resposta verificada para este pedido. Suas palavras foram mantidas; nenhum rascunho foi produzido.',
      failed:
        'Não consegui uma resposta válida. Suas palavras foram mantidas; nenhum rascunho foi produzido.',
      notSaved: 'Este navegador não conseguiu salvar estas mensagens. Mantenha esta página aberta.',
      capacity: 'Esta conversa chegou ao limite. Suas mensagens anteriores foram mantidas.',
    },
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
        'US$ 80.000 para ter US$ 300 por mês de renda, 5 anos, risco baixo',
      ],
    },
    readerMissed: (fields: string) =>
      `Não encontrei isto no seu objetivo: ${fields}. Preencha abaixo.`,
    sheet: {
      title: 'Como li seu objetivo',
      parser: 'leitor',
      summaryOne: '1 coisa ainda não se encaixa. Corrija para montar o plano.',
      summaryOther: '{n} coisas ainda não se encaixam. Corrija para montar o plano.',
      missingOne: 'Ainda falta 1 coisa. Preencha para montar o plano.',
      missingOther: 'Ainda faltam {n} coisas. Preencha para montar o plano.',
      goToField: 'Ir para o campo',
      build: 'Montar meu plano',
      signInToBuild: 'Entrar para montar meu plano',
      more: 'Mais limites',
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
      optional: 'Opcional',
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
      country: 'Pode deixar em branco. O plano não usa esse dado.',
      countryFromBrowser:
        'Tirado do idioma deste navegador. Pode mudar ou deixar em branco: o plano não usa esse dado.',
      holdings: 'O plano preenche lacunas e evita repetir o que você já tem.',
      amount: 'Com quanto o plano começa, de US$ 10 a US$ 1.000.000.',
      notFound: 'Não encontrei no seu objetivo: preencha.',
      assumed: 'Seu objetivo não disse isto: eu assumi. Mude se estiver errado.',
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
    },
    blocked: {
      chainNotChosen: 'Escolha primeiro uma rede na barra no topo.',
      chainUnknown:
        'Ainda não sei em qual rede seu plano fica, então não consigo montar para ela. Pergunte de novo, acima.',
      refused: 'Nosso servidor não aceitou esses limites. Confira cada campo e tente de novo.',
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
      sentenceOpen: {
        grow: (amount: string) => `Fazer ${amount} crescer, sem data definida.`,
        income: (amount: string) => `Gerar renda com ${amount}, sem data definida.`,
        protect: (amount: string) => `Proteger ${amount}, sem data definida.`,
      },
      noDate: 'Sem data definida',
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
    buy: (amount: string, when: string) => `Compra de ${amount} · ${when}`,
    order: (when: string) => `Ordem · ${when}`,
    follow: (when: string) => `Seguir um portfólio compartilhado · ${when}`,
    withdraw: (when: string) => `Saque · ${when}`,
    publish: (when: string) => `Publicar um portfólio · ${when}`,
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
    overview: {
      title: 'Visão geral do portfólio',
      value: 'Valor total · dólares',
      partialValue: 'Valor dos cofres lidos · dólares',
      vaults: 'Cofres lidos',
      holdings: 'Posições nos cofres',
      partial:
        'Esta visão inclui apenas as redes que responderam. Redes indisponíveis não entram na conta.',
      open: 'Abrir cofre',
      details: 'Detalhes dos ativos e plano',
      actions: 'Ações do cofre',
    },
    chainOut: (chain: string) => `${chain} está indisponível agora.`,
    chainOff: (chain: string) => `${chain} está indisponível no nosso servidor por enquanto.`,
    notHeld: (chain: string) =>
      `Nenhuma carteira desta conta está na ${chain}, então nada é lido lá.`,
    title: (vaults: number) =>
      vaults > 1 ? 'O que seus cofres guardam.' : 'O que seu cofre guarda.',
    planDetails: 'Detalhes do objetivo e da estratégia',
    lead: 'Seus cofres, seus ativos e as estratégias que seguem. Abra um cofre para continuar a conversa ou adicionar dinheiro.',
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
      unfinished:
        'Uma compra parou depois do depósito, então este cofre tem mais caixa do que o plano prevê. O caixa está seguro aqui.',
      address: 'Endereço do cofre',
      page: (address: string) => `Abrir a página do cofre ${address}`,
      value: 'Valor',
      cash: 'Caixa',
      autoFollow: 'Seguir automaticamente',
      on: 'Ativado',
      off: 'Desativado',
      lossUsed: 'Perdas do agente, últimos 7 dias',
      holdings: 'O que você tem',
      details: 'Detalhes',
      version: 'Versão do portfólio que ele segue',
      followsNothing: 'Ele não segue nenhum portfólio compartilhado: você define as fatias.',
      openPage: 'Abrir a página deste cofre',
      parts: 'As partes, por peso',
      planTitle: (parts: number) =>
        parts === 1 ? 'Seu plano · 1 parte' : `Seu plano · ${parts} partes`,
      tooMany: 'Mais partes do que uma barra mostra: cada uma está na tabela abaixo.',
      target: (share: string) => `planejado ${share}`,
      onlyCash: 'Só caixa por enquanto: nada foi comprado para este cofre ainda.',
      columns: {
        asset: 'Ativo',
        amount: 'Quantidade',
        price: 'Preço',
        value: 'Valor',
        weight: 'Fatia agora',
        target: 'Planejado',
        drift: 'Diferença',
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
      takenOut: 'Sacado, conforme pedido',
      takenOrdered:
        'Isto conta o que seus saques pediram. Um token que algum deles não conseguiu mover continua nas posições abaixo.',
      takenOutMethod: (n: number) =>
        `${n === 1 ? '1 token sacado' : `${n} tokens sacados`}, cada um ao preço de referência quando pedido`,
      takenUnvalued: (n: number) =>
        `${n === 1 ? 'Um token sacado não tinha' : `${n} tokens sacados não tinham`} preço na hora, e não ${n === 1 ? 'entra' : 'entram'} em soma.`,
      positionMethod: (method: string) => `${method}; vezes a quantidade que o cofre guarda`,
    },
    goalCard: {
      builtMet: 'No caminho quando o plano foi montado',
      builtShort: 'Abaixo da renda quando o plano foi montado',
      builtPaid: (paid: string, asked: string) =>
        `Quando este plano foi montado, ele pagava ${paid} por mês dos ${asked} que você pediu.`,
      due: (date: string) => `Data do objetivo: ${date}`,
      unknown: (chain: string) => `Seu cofre na ${chain}.`,
      notJoined:
        'Este cofre não tem um objetivo que eu consiga ler: foi comprado a partir de um portfólio compartilhado, que não tem, ou antes de os planos guardarem seu objetivo. O que ele guarda está abaixo.',
      follows: (name: string) => `Seu cofre segue ${name}.`,
      followsShared: 'Ele segue um portfólio compartilhado. O que ele guarda está abaixo.',
      seeShared: 'Ver esse portfólio',
      putIn: (amount: string) => `você colocou ${amount}`,
      tookOut: 'você sacou parte depois',
      seePlan: 'Ver seu plano',
      seeOrder: 'Ver a ordem',
      startGoal: 'Comece pelo seu objetivo',
    },
    actions: {
      label: 'Este cofre',
      unnamed: (chain: string) => `Seu cofre na ${chain}`,
      addMoney: 'Adicionar dinheiro',
      rename: 'Renomear',
      newPlan: 'Novo plano',
      nameLabel: 'Nome deste cofre',
      nameHint: 'Até 60 caracteres. Só você vê.',
      save: 'Salvar o nome',
      saving: 'Salvando…',
      cancel: 'Cancelar',
      clear: 'Remover o nome',
      failure: {
        invalid:
          'Um nome tem de 1 a 60 caracteres de texto simples. Encurte, ou tire o que não é texto, e salve de novo.',
        signedOut:
          'Nosso servidor não reconhece mais o seu login, então o nome não foi salvo. Saia e entre de novo.',
        notYours:
          'Nosso servidor não lista este cofre como seu, então o nome não foi salvo. Leia seu portfólio de novo.',
        unreachable: 'Não consegui salvar o nome: nosso servidor não respondeu. Tente de novo.',
      },
    },
    add: {
      strategy: 'Destino deste aporte',
      title: 'Adicione dinheiro ao seu cofre',
      lead: (chain: string) =>
        `Adicione a este cofre na ${chain} seguindo sua estratégia atual. Revise o aporte e seus passos antes de assinar na carteira.`,
      amountHint: 'De US$ 10 a US$ 1.000.000.',
      missing:
        'Não encontro este cofre entre os seus. Abra seu portfólio e escolha o cofre por lá.',
      back: 'Voltar ao seu portfólio',
      otherWallet: (address: string) =>
        `Este cofre pertence a outra carteira sua (${address}). Entre com essa carteira para adicionar dinheiro a ele.`,
      noVault:
        'Nosso servidor não lista mais este cofre como seu. Leia seu portfólio de novo e tente outra vez.',
      keeper:
        'Seguir automático está ativado neste cofre, então este aporte só deposita o caixa. Nosso operador compra os ativos do cofre com ele quando rebalancear este cofre de novo.',
      newerVersion: (version: number) =>
        `O portfólio que este cofre segue tem uma versão mais nova, a versão ${version}. Este aporte compra as metas atuais do cofre; aceitar a nova versão é um passo separado.`,
      source: {
        read: (chain: string) =>
          `Lido da ${chain} por este app, não do nosso servidor: as metas que este aporte compra são as da rede.`,
        mock: 'Rede de exemplo: não há rede para ler, então as metas são palavras do nosso servidor, sem conferência.',
        notRead: (chain: string) =>
          `Sem conferência com a ${chain}: este app não tem um nó próprio para ler. As metas são palavras do nosso servidor.`,
        failed: (chain: string) =>
          `Não consegui ler este cofre na ${chain}: o nó que este app lê não respondeu, ou o que nosso servidor indicou não é o cofre que a rede guarda. Não ofereço adicionar dinheiro até conseguir.`,
        missing: (chain: string) =>
          `Li a ${chain}, e ela não guarda um cofre assim para a sua carteira, então não ofereço adicionar dinheiro a ele.`,
        differs: (chain: string) =>
          `A resposta do nosso servidor difere das metas que a ${chain} guarda para este cofre, então não ofereço adicionar dinheiro agora. Leia seu portfólio de novo em instantes.`,
        unlisted:
          'Este cofre tem um peso-alvo em um token que este app não lista, então não consigo conferir um aporte e não ofereço um.',
      },
    },
    summary: {
      title: 'Seus cofres',
      worth: (chain: string) => `Seu cofre na ${chain} vale`,
      many: (vaults: number, chain: string) => `Você tem ${vaults} cofres na ${chain}.`,
      manyChains: (vaults: number, chains: string) => `Você tem ${vaults} cofres, na ${chains}.`,
      see: 'Ver seu portfólio',
    },
  },

  talk: {
    workbench: {
      title: 'Investir',
      strategy: 'Prévia da estratégia',
    },
    startOver: 'Começar de novo',
    you: 'Você',
    me: 'tenonfi',
  },

  plan: {
    title: 'Seu plano',
    signedOut: 'Entre para ver este plano. Um plano é de uma pessoa, na rede da carteira dela.',
    fromLink:
      'Este plano veio de um link: nosso motor o montou com os limites que o link trazia, que outra pessoa pode ter definido. Confira o objetivo, o valor e os limites acima antes de comprar.',
    missing: {
      title: 'Não encontro este plano para você.',
      body: 'Não é um plano feito com este login, ou não está mais guardado. Nada dele é aproveitado: descreva seu objetivo na conversa e eu proponho uma nova mistura.',
      again: 'Descrever seu objetivo',
    },
    backToGoal: 'Voltar ao seu objetivo',
    unsignable: (plan: string) =>
      `Este plano está na ${plan}, e a carteira com que você entrou não assina nela. Entre com uma carteira que assine, ou descreva seu objetivo na conversa para uma nova mistura.`,
    split:
      'Este plano está dividido entre duas redes, e um plano fica em uma só. Ele não pode ser comprado como está: descreva seu objetivo na conversa para uma nova mistura.',
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
      origin: (who: string) =>
        who === 'model'
          ? 'Esta divisão foi proposta na sua conversa, e você a confirmou.'
          : 'Você mesmo escolheu esta divisão.',
      confirmed: (warning: string, asset: string) => {
        switch (warning) {
          case 'EXIT_OVER_CAPACITY':
            return `Você confirmou ter mais ${asset} do que a saída medida comporta no plano.`;
          case 'EXIT_OVER_TIER_CEILING':
            return `Você confirmou ter mais ${asset} do que o limite da faixa dele, enquanto o custo de venda não está medido.`;
          case 'OVER_LISTED_CAP':
            return `Você confirmou mais ${asset} do que o teto dele na lista de ativos.`;
          case 'NOT_FOR_GOAL':
            return `Você confirmou ${asset}, que um plano com este objetivo normalmente não tem.`;
          case 'STOPS_FOLLOWING':
            return 'Você confirmou que as suas metas substituem a carteira compartilhada que este cofre seguia.';
          default:
            return 'Você confirmou um aviso sobre esta divisão.';
        }
      },
      other: 'O plano traz mais uma observação que ainda não sabemos descrever.',
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
      paidLabel: (months: number, low: string, high: string) =>
        `O que o rendimento em dólar paga em ${months} meses, somado: de ${low} a ${high} ao ano, projetado.`,
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
    whyShare: 'Por que essa parcela',
    exitScale: 'A barra cheia é 1%, o custo em que a venda é medida.',
    income: {
      asked: (amount: string) => `pedido: ${amount} por mês`,
    },
    fall: {
      putOpen: (amount: string) => `A barra inteira são os ${amount} que você coloca.`,
      put: (amount: string, months: string) =>
        `A barra inteira são os ${amount} que você coloca, por ${months}.`,
    },
    columns: {
      asset: 'Ativo',
      share: 'Parte',
      amount: 'Valor',
      yield: 'Rendimento após desconto',
      why: 'Por quê',
    },
    noReason: 'Nenhum motivo informado.',
    projected: 'Faixa projetada por ano, não é uma promessa',
    projectedValue: (low: string, high: string) => `${low} a ${high}`,
    basis: (basis: string) => `Como foi calculada: ${String(basis).replace(/[.\s]+$/, '')}.`,
    lossInFall: (amount: string) =>
      `Numa queda forte, o motor conta uma perda de cerca de ${amount} neste plano.`,
    exitUnmeasured: 'Ainda não foi medido, então nenhum custo é mostrado.',
    exitCost: (cost: string) => `≤ ${cost}`,
    inKind:
      'Você pode tirar os próprios tokens do seu cofre a qualquer momento. Vendê-los por dinheiro para você ainda não é oferecido.',
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
      ways: 'Para fechar a diferença:',
      change: 'Mudar meus limites',
    },
    monthly: {
      figure: (low: string, high: string) =>
        low === high ? `Cerca de ${low} por mês` : `Cerca de ${low} a ${high} por mês`,
      after: 'se a faixa projetada se mantiver. Uma estimativa, não uma promessa.',
    },
    buy: 'Comprar este plano',
    invest: (amount: string) => `Investir ${amount}`,
    investing: 'Abrindo os passos…',
    answer: {
      inFall: (share: string, what: string, loss: string) =>
        `${share} em ${what} · numa queda forte, cerca de −${loss}`,
      inNoFall: (share: string, what: string) =>
        `${share} em ${what} · nenhuma perda contada numa queda forte`,
      yieldAfter: 'ao ano do rendimento em dólar, projetado. Não é promessa.',
      range: (low: string, high: string) => `${low} a ${high} ao ano`,
      rangeAfter: 'projetado. Uma faixa, não uma promessa.',
      none: 'Ainda sem projeção: não há leitura de rendimento para este plano.',
    },
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
      other: (planned: string) =>
        `Seu plano foi montado para ${planned}, e os limites dele foram calculados para esse valor. Para comprar outro valor, descreva seu objetivo na conversa e use a nova mistura nesse valor.`,
    },
    steps: {
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
      AMOUNT_OVER_REVIEW:
        'Esta mistura foi revisada com um valor menor e não é comprada acima dele. Diminua o valor ou revise a mistura de novo com o novo valor.',
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
        `Explore estratégias publicadas na ${chain}. Abra uma para revisar os ativos, as fontes e as opções de investir ou seguir.`,
      leadAll:
        'Cada um é uma lista de ativos e pesos que quem o criou publicou numa rede. Entre para ver os da sua rede.',
      loading: 'Lendo os portfólios compartilhados…',
      empty: (chain: string) => `Nenhum portfólio foi compartilhado na ${chain} ainda.`,
      emptyAll: 'Nenhum portfólio foi compartilhado ainda.',
      publish: 'Publicar um portfólio',
      publishSoon: (chain: string) =>
        `Publicar um portfólio na ${chain} está a caminho. Por enquanto dá para publicar na Solana.`,
      signedOut: (chain: string) =>
        `Você saiu da conta. Esta ainda é a prateleira da ${chain}; entre para seguir um portfólio.`,
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
    product: {
      yield: 'Rendimento ao ano, após o desconto',
      noYieldReading: 'nenhum ativo tem leitura de rendimento',
      answer: (kinds: string, chain: string) => `${kinds}, na ${chain}.`,
      sub: (version: string, since: string) => `${version} · em vigor ${since}`,
      why: {
        stock: 'Segue o preço da ação que lhe dá nome. Não paga rendimento.',
        etf: 'Segue o preço do fundo que lhe dá nome. Não paga rendimento.',
        gold: 'Segue o preço do ouro. Não paga rendimento.',
        commodity: 'Segue o preço da commodity que lhe dá nome. Não paga rendimento.',
        dollar_yield: 'Um token de dólar que rende.',
        crypto: 'Segue o preço da moeda que lhe dá nome. Não paga rendimento.',
        cash: 'O dólar da rede, guardado como caixa.',
        unknown: 'Um token que este app não lista.',
        unread: 'Nosso servidor não tem registro de que tipo de token é este.',
      },
      exit: {
        about: (amount: string, days: number) => `cerca de ${amount} em até ${days} dias`,
        atLeast: (amount: string, days: number) => `pelo menos ${amount} em até ${days} dias`,
        cost: (cost: string) => `≤ ${cost}`,
        notMeasured: (names: string) =>
          `A venda de ${names} ainda não foi medida, então nenhum custo é mostrado para ela.`,
      },
      publisher: 'Publicado por',
    },
    refusal: {
      versionChanged:
        'Este portfólio tem uma versão nova desde que você abriu esta página. Abra de novo para ver o que ele guarda agora.',
      reopen: 'Abrir o portfólio de novo',
      reread: 'Ler o portfólio de novo',
      assetNamed: (asset: string) =>
        `${asset} não pode ser comprado nesta rede agora, então este portfólio não pode ser comprado como está.`,
      asset:
        'Um ativo deste portfólio não pode ser comprado nesta rede agora, então o portfólio não pode ser comprado como está.',
    },
    family: {
      nextStep: 'Revise a estratégia e escolha quanto investir.',
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
      buy: 'Investir neste portfólio',
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
        'no-reader': (chain: string) =>
          `Não conferido na ${chain}: este app ainda não lê o registro da ${chain}. Estas são palavras do nosso servidor.`,
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
      notFollowing: 'Segue outro portfólio',
      ownPlan: 'Guarda o seu próprio plano',
      followWith: 'Seguir com este cofre',
      noFollowers: 'Nenhum dos seus cofres nesta rede segue este portfólio ainda.',
      noHoldings: 'Ainda não há ativos neste cofre.',
      useExisting: 'Usar um cofre existente',
      closeChooser: 'Fechar seleção de cofres',
      choose: 'Escolher este cofre',
      selected: 'Cofre selecionado',
      reviewFollow: 'Revisar atualização do cofre',
      reviewTarget: (vault: string, portfolio: string, version: number) =>
        `“${vault}” seguirá ${portfolio}, versão ${version}. Revise a mudança antes de assinar.`,
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
      title: 'Compartilhe a estratégia do seu cofre.',
      lead: (chain: string) =>
        `Compartilhe a estratégia registrada no seu cofre na ${chain}. Revise os ativos e pesos-alvo exatos, dê um nome e uma descrição públicos e assine a publicação.`,
      signIn: 'Entre para publicar um portfólio.',
      shareStrategy: 'Compartilhar estratégia',
      sourceVault: 'Seu cofre de origem',
      sourceHint: 'Escolha um cofre seu na rede ativa.',
      chooseVault: 'Escolha seu cofre',
      noVaults: 'Escolha um cofre seu nesta rede antes de compartilhar uma estratégia.',
      readingVaults: 'Lendo seus cofres…',
      readingStrategy: 'Lendo a estratégia do cofre…',
      sourceUnavailable:
        'Não consegui ler seus cofres. Abra o cofre e tente compartilhar novamente.',
      editStrategy: 'Voltar à conversa do cofre',
      privacy:
        'Só esta estratégia revisada, o nome e a descrição ficam públicos. A conversa do cofre permanece privada.',
      holdings: 'Tokens mantidos agora · separados dos pesos-alvo',
      strategySource: (source: string) => `Estratégia lida de ${source}.`,
      strategyChanged:
        'A estratégia do cofre mudou. As metas atuais estão na tela. Revise antes de compartilhar novamente.',
      sourceProblems: {
        unsupported:
          'A estratégia completa deste cofre não pode ser compartilhada nas regras atuais do registro. Metas ausentes, aninhadas, desconhecidas ou de caixa não são substituídas. Volte à conversa do cofre para ajustar a estratégia.',
        unverified:
          'Não consegui verificar a estratégia e o proprietário nesta rede. A publicação está pausada. Volte ao cofre e tente novamente.',
        missing: 'Não encontrei este cofre na rede. Escolha um cofre atual seu.',
        owner:
          'Este cofre não corresponde à carteira conectada, rede, endereço e número do plano. Escolha um cofre seu.',
        unreachable: 'Não consegui ler o cofre. Volte ao cofre e tente novamente.',
      },
      about: 'Nome e descrição',
      name: 'Nome',
      nameHint: 'Letras, números e pontuação simples, até 280 caracteres.',
      slug: 'Endereço na prateleira',
      slugHint: 'Letras minúsculas, números e hífens. Não muda depois de publicado.',
      copy: 'Descrição',
      copyHint: 'Até 280 caracteres, sem link.',
      familyId: 'O identificador dele, calculado a partir do endereço',
      assets: 'Ativos e pesos',
      assetsHint:
        'Estes são os pesos-alvo do cofre. Compartilhar exige de 3 a 12 ativos listados, de 2% a 50% em passos de 0,5%, sem peso-alvo de caixa. Ajuste a estratégia no cofre antes de compartilhar se ela não couber.',
      asset: 'Ativo',
      weight: 'Peso, em %',
      assetOf: (n: number) => `Ativo ${n}`,
      weightOf: (n: number) => `Peso do ativo ${n} (%)`,
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
        chain: 'Publicar ainda não está aberto nesta rede.',
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
      conversation: {
        proposedShare: 'Fatia proposta',
        resume: 'Retomar conversa',
        holdings: 'Ativos',
        explain: 'Explique meus ativos',
        explainPrompt:
          'Explique o que meu cofre tem e como isso se relaciona com sua estratégia atual.',
        considerChange: 'Considerar uma mudança',
        changePrompt: 'Quero considerar uma mudança na estratégia do meu cofre.',
        discuss: 'Conversar sobre esta proposta',
        discussPrompt:
          'Ajude a revisar a estratégia proposta, suas consequências e o que ainda não sabemos.',
        change: 'Mudança',
        points: 'p.p.',
        removed: 'Removido da estratégia proposta',
        details: 'Detalhes do cofre e fontes dos preços',
        draftIntro: 'Proposta preliminar, não aplicada:',
        comparison: 'Meta atual → fatia proposta',
        reasons: 'Escolhas e fontes',
        tradeoffs: 'Escolhas e consequências',
        unknowns: 'O que não sabemos',
        sources: 'Fontes',
        title: 'Conversa sobre seu cofre',
        loading: 'Abrindo a conversa…',
        saved: 'Salva na sua conta',
        local: 'Neste navegador · o armazenamento na conta está indisponível',
        conflict:
          'Existe outra versão salva. Suas palavras permanecem neste navegador. A conversa está pausada até reconciliar as versões.',
        notSaved:
          'Este navegador não conseguiu salvar estas mensagens. Mantenha esta página aberta.',
        capacity: 'Esta conversa chegou ao limite. Suas mensagens anteriores foram mantidas.',
        unavailable:
          'Sua mensagem está salva. O serviço de conversa do cofre ainda não está disponível; nenhuma resposta ou mudança de estratégia foi produzida.',
        failed:
          'Não consegui uma resposta. Suas palavras foram mantidas; nenhuma mudança de estratégia foi produzida.',
        reread:
          'O cofre foi lido de novo enquanto eu respondia, então deixei essa resposta de lado. Suas palavras foram mantidas; pergunte de novo para ter uma resposta sobre o que ele tem agora.',
        pending:
          'Uma conversa sobre este cofre, com o que ele tem agora como contexto. O serviço de conversa está sendo conectado.',
        empty:
          'Pergunte sobre o que este cofre tem, sua estratégia ou uma mudança que deseja considerar.',
        history: 'Conversa salva',
        you: 'Você',
        agent: 'Tenonfi',
        placeholder: 'Pergunte sobre este cofre ou descreva uma mudança…',
        submitMessage: 'Enviar mensagem',
        reading: 'Buscando uma resposta…',
        current: 'O que tem agora',
        noHoldings: 'Este cofre não tem tokens agora.',
        targets: 'Metas da estratégia atual',
        targetsNote: 'Metas registradas na rede, separadas das fatias mantidas agora.',
        proposed: 'Estratégia proposta',
        previewOnly:
          'Somente uma prévia. Seu cofre não mudou. Aplicar uma atualização de estratégia ainda não está disponível aqui.',
      },
      address: 'Endereço do cofre',
      workspaceLead: (chain: string) =>
        `Seus ativos e estratégia na ${chain}. Continue a conversa aqui conforme seus planos mudam.`,
      lead: (chain: string) =>
        `Lido da ${chain} para esta página. Qualquer pessoa pode ver um cofre: o que ele tem é público na rede.`,
      loading: 'Lendo o cofre…',
      missing: 'Não há cofre neste endereço.',
      back: 'Voltar ao seu portfólio',
      explorer: (explorer: string) => `Ver no ${explorer}`,
      owner: 'Dono',
      follows: 'Segue',
      followsNothing: 'Nada: quem é dono define os pesos',
      autoFollowOff:
        'O seguir automático está desativado neste cofre. Para ativar, abra o portfólio compartilhado que ele segue e escolha o seguir automático lá.',
      autoFollowWhere: 'Portfólios compartilhados',
      version: (n: number) => `versão ${n}`,
      autoFollow: 'Seguir automático',
      value: 'Valor',
      cash: 'Dinheiro',
      columns: {
        asset: 'Ativo',
        held: 'Quantidade',
        price: 'Preço',
        weight: 'Fatia agora',
        target: 'Planejado',
        drift: 'Diferença',
      },
      on: 'Ativado',
      off: 'Desativado',
    },
  },

  withdraw: {
    meta: 'Sacar',
    title: 'Sacar do seu cofre',
    lead: (chain: string) =>
      `Os tokens saem do seu cofre como estão e vão para a sua própria carteira em ${chain}. Nada é vendido.`,
    loading: 'Lendo seu cofre…',
    failed: 'Não consegui ler seus cofres: nosso servidor não respondeu. Tente de novo.',
    notYours: 'Este cofre não é seu, então não há nada para sacar aqui.',
    empty: 'Este cofre está vazio: não há nada nele agora.',
    back: 'Voltar ao seu portfólio',
    action: 'Sacar',
    steps: {
      label: 'Passos para sacar',
      names: { what: 'O quê', check: 'Revisar', confirm: 'Assinar' },
      done: 'feito',
      next: 'Continuar',
    },
    what: {
      legend: 'O que você quer tirar?',
      everything: 'Tudo o que o cofre tem',
      some: 'Escolher tokens e valores',
      take: (name: string) => `Sacar ${name}`,
      holds: (amount: string) => `O cofre tem ${amount}.`,
      amount: (symbol: string) => `Quantidade de ${symbol}`,
      amountHint: 'Deixe vazio para tirar tudo.',
      wholeOnly: 'Tudo ou nada: este app não conhece as unidades deste token.',
      errors: {
        amount: 'Digite uma quantidade deste token, ou deixe vazio para tirar tudo.',
        over: (held: string) => `O cofre tem ${held}. Digite isso ou menos.`,
        none: 'Escolha pelo menos um token para continuar.',
      },
      summaryAll: 'Tudo',
      summarySome: (n: number) => (n === 1 ? '1 token' : `${n} tokens`),
    },
    check: {
      leaves: 'O que sai do cofre',
      token: 'Token',
      amount: 'Quantidade',
      all: (held: string) => `Tudo: ${held} agora`,
      to: 'Vai para',
      own: 'Sua própria carteira',
      from: 'Do seu cofre',
      onlyOwner:
        'Um cofre só paga ao seu dono. Sua carteira só é chamada a assinar um saque exatamente destes tokens para este endereço.',
      stays: 'Todo o resto fica no cofre.',
      emptied: 'O cofre ficará vazio depois.',
      autoFollow:
        'O seguir automático para neste cofre. Ele está ativado, e o primeiro passo o desativa, para que nosso operador não negocie o cofre enquanto você saca nem depois. Para ativar de novo, abra o portfólio compartilhado que este cofre segue; a página do cofre leva até lá.',
      noSale:
        'Vender por dinheiro antes de sacar ainda não é oferecido; você pode sacar os próprios tokens.',
      seen: 'Revisado',
      confirm: 'É isto que quero sacar',
    },
    confirm: {
      lead: 'Em seguida você revisa cada passo da ordem e assina na sua carteira. A taxa da rede é paga pela sua carteira.',
      button: 'Revisar os passos para sacar',
      busy: 'Criando sua ordem…',
      blocked: {
        what: 'Escolha primeiro o que sacar.',
        check: 'Confirme primeiro o que sai.',
        owner: 'Nenhuma carteira sua está conectada nesta rede.',
        chain: (chain: string) => `${chain} ainda não está pronta para assinar aqui.`,
        vault:
          'Não consegui confirmar que este cofre é da sua carteira, então não ofereço o saque. Nada foi assinado.',
      },
    },
  },

  invest: {
    label: 'Investir',
    buying: 'O que você está comprando',
    columns: { holding: 'Ativo', share: 'Parte', amount: 'Valor' },
    cash: 'Fica em dinheiro',
    press: (amount: string) => `Investir ${amount}`,
    checkingFunds: 'Conferindo sua carteira…',
    preparing: 'Lendo os preços da sua ordem…',
    again: 'Ler os preços de novo',
    short: {
      cap: (most: string, times: number) =>
        `Os fundos de teste enviam até ${most} por vez, ${times} vezes por dia, então um envio não cobre este valor.`,
      sendAnyway: (most: string) => `Enviar ${most} mesmo assim`,
      instead: (amount: string) => `Investir ${amount} em vez disso`,
      covers: (amount: string) => `Sua carteira cobre ${amount} agora.`,
      typeLess: 'Ou digite um valor menor.',
      inGoal: 'Para investir outro valor, toque no valor do seu objetivo e mude.',
    },
    old: 'Estes preços estão velhos: a ordem venceu antes de ser confirmada. Leia de novo para investir.',
    updated: 'Preços atualizados. Leia os passos de novo antes de confirmar.',
    updatedHold: 'Os preços acabaram de mudar: leia primeiro.',
    fee: {
      none: 'Não cobramos taxa nesta ordem. A taxa da rede sai da sua carteira.',
      some: (list: string) => `Taxas desta ordem: ${list}. A taxa da rede sai da sua carteira.`,
    },
    signs: {
      passkey: (n: number) =>
        n === 1
          ? 'Um toque assina o único passo com sua carteira de chave de acesso. Nenhuma outra janela abre.'
          : `Um toque assina os ${n} passos com sua carteira de chave de acesso, um depois do outro. Nenhuma outra janela abre, e você pode parar entre os passos.`,
      wallet: (n: number) =>
        n === 1
          ? 'Sua carteira pede que você confirme o único passo na janela dela.'
          : `Sua carteira pede que você confirme cada um dos ${n} passos na janela dela.`,
    },
    stop: 'Parar depois deste passo',
    stopping: 'Parando quando este passo terminar. O que já foi assinado ainda é enviado.',
    progress: {
      depositing: 'Depositando',
      deposited: 'Depósito confirmado',
      depositingAndBuying: (names: string) => `Depositando e comprando ${names}`,
      depositedAndBought: (names: string) => `Depósito confirmado, ${names} comprado`,
      approving: 'Autorizando o depósito',
      approved: 'Depósito autorizado',
      buying: (names: string) => `Comprando ${names}`,
      bought: (names: string) => `${names} comprado`,
      confirmed: (what: string) => `${what}, confirmado`,
      line: (did: string | null, doing: string, n: number, of: number) =>
        `${did ? `${did} · ` : ''}${doing} · ${n} de ${of}`,
    },
    things: {
      deposit: 'o depósito',
      approval: 'a autorização do depósito',
      step: 'um passo',
    },
    stopped: {
      nothing: 'Nada chegou à rede ainda: nenhum passo está confirmado.',
      all: (landed: string) => `O que chegou: ${landed}.`,
      some: (landed: string, not: string) => `O que chegou: ${landed}. O que não chegou: ${not}.`,
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
      continuesLead:
        'Esta ordem termina uma compra que parou: compra o que faltou com o caixa que já está no seu cofre e não deposita nada. Cada passo é montado na hora, conferido com o que você vê aqui e só então assinado pela sua carteira.',
      fromVault: 'Do caixa do seu cofre',
      unseen:
        'Este aparelho não viu a revisão da primeira ordem. O que falta comprar é o que nosso servidor lista, e eu confiro com os ativos do seu plano.',
      deposit: 'Depósito',
      steps: 'Passos',
      expires: 'Assine antes de',
      spend: (amount: string, asset: string) => `Gastar ${amount} em ${asset}`,
      atMostUnder: (pct: string) => `no máximo ${pct} abaixo da cotação`,
      atLeastWhole: (amount: string) => `receber pelo menos ${amount}`,
      atMostEach: (price: string) => `no máximo ${price} cada`,
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
      withdraw:
        'Esta ordem tira outros tokens ou quantidades do que os que você revisou, então não ofereço para assinar. Nada foi assinado. Faça um novo saque.',
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
      addTitle: 'Onde você adiciona',
      addNote:
        'O valor compra estes ativos nestes pesos, as metas que seu cofre mostrava quando você o escolheu. O que elas deixam fica no cofre como caixa.',
      addCashNote: 'Este cofre não tem metas, então o valor inteiro fica nele como caixa.',
      publishNote:
        'Sua carteira só é chamada para assinar uma transação que publique exatamente este nome, esta descrição e estes pesos, com este identificador.',
      signPublish: 'Assinar e publicar',
      signFollow: 'Assinar e seguir',
      withdrawTitle: 'O que você saca',
      signWithdraw: 'Assinar e sacar',
      withdraws: (amount: string) => `${amount} para a sua própria carteira`,
      withdrawsAll: (held: string) => `Tudo, ${held} na revisão, para a sua própria carteira`,
      withdrawDone: 'O que você sacou está na sua carteira agora.',
      autoFollowStops: 'O seguir automático para neste cofre: o primeiro passo o desativa.',
      skipped: (what: string) =>
        `${what} ficou no cofre: não pode ser movido agora. O emissor pode tê-lo congelado, ou ele precisa de uma carteira que trate suas regras de transferência.`,
      doneStayed: (chain: string, what: string) =>
        `Feito em ${chain}, exceto ${what}: o cofre ainda guarda. Não foi movido, e nenhum passo avisou.`,
      doneUnread: (chain: string) =>
        `Feito em ${chain}. Não consegui ler seu cofre de novo; veja no portfólio se algo ficou.`,
      stayed: (what: string) =>
        `${what} ficou no cofre: o contrato do cofre não conseguiu mover agora. Você pode tentar sacar de novo depois.`,
      doneExcept: (chain: string, n: number) =>
        n === 1
          ? `Feito em ${chain}, exceto um passo que foi pulado: o que ele moveria ficou no cofre.`
          : `Feito em ${chain}, exceto ${n} passos que foram pulados: o que eles moveriam ficou no cofre.`,
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
      create_vault_buy: 'Abrir seu cofre, depositar e comprar',
      deposit_buy: 'Depositar e comprar',
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
        `Todos os passos estão confirmados em ${chain}. A transação de cada passo está no link ao lado dele.`,
      seePortfolio: 'Ver seu portfólio',
      buyMore: 'Comprar mais',
      depositKept:
        'O que você depositou está no seu cofre, em caixa: nada se perdeu. Uma nova ordem depositaria de novo.',
      stopped: (amount: string) =>
        `Seus ${amount} estão seguros no seu cofre, em caixa. A etapa de compra não foi concluída.`,
      forSupport: 'Detalhes para o suporte',
      finish: 'Terminar a compra com o caixa do seu cofre',
      finishing: 'Criando a ordem…',
      finishNote:
        'Uma nova ordem para os passos que ficaram, ao preço de agora. Ela não deposita nada: você revisa e assina como antes.',
      finishOther: 'Outra ordem já termina esta compra: o que falta comprar está nela.',
      openThatOrder: 'Abrir essa ordem',
      finishWorking: 'Outro pedido está trabalhando nesta ordem. Tente de novo em instantes.',
      finishNothing: 'Não falta nada para comprar nesta ordem: todos os passos dela foram feitos.',
      finishShort:
        'Seu cofre agora tem menos caixa do que os passos que faltam gastariam: parte foi gasta ou retirada desde então. Nada foi criado. Adicione dinheiro ao cofre para o que ainda quer comprar.',
      finishUnsupported: 'Esta ordem não pode ser terminada dessa forma. Faça uma nova ordem.',
      keeperBuys:
        'Seguir automático está ativado neste cofre agora, então nosso operador compra os ativos do cofre com este caixa quando rebalancear o cofre de novo. Não há mais nada para assinar.',
      finishNotDeposited:
        'O depósito desta ordem ainda não chegou, então não há caixa no cofre para terminar a compra. Assine os passos dela na ordem primeiro.',
      finishLater:
        'Um passo assinado antes ainda pode chegar. Olhe de novo em um minuto e tente outra vez.',
      finishRefused: (why: string) =>
        `Não consegui criar essa ordem. Nosso servidor disse: ${why}.`,
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
  /** Misturas da conversa ou da própria pessoa (gate ANY-COMPOSITION, #191). */
  mix: {
    activity: (when: string) => `Novos pesos-alvo do seu cofre · ${when}`,
    preview: {
      use: 'Usar esta mistura',
      apply: 'Aplicar ao meu cofre',
      notes: 'Como os pesos foram definidos',
      notesAlone: 'Sobre as proporções que você deu',
      warnings: 'Antes de usar',
      note: {
        equalAll: 'As escolhas dividem o cofre em partes iguais: você não deu proporções.',
        equalRest: (names: string) => `${names} dividem o restante em partes iguais.`,
        stated: (names: string, quote: string) => `${names} seguem o que você disse: “${quote}”.`,
        scaled: 'As proporções que você deu não somavam o todo, então ajustei para o todo.',
        dropped: (name: string) =>
          `${name} ficou de fora: suas proporções não deixam nada para ele.`,
        unmet: (quote: string) => `Estas escolhas não conseguem cumprir “${quote}”.`,
        unread: (quote: string) =>
          `Não apliquei “${quote}”. Diga como proporção, por exemplo “40% em ouro”, e eu aplico.`,
        withdrawn: (quote: string) => `Não sigo mais “${quote}” nos pesos: você retirou.`,
      },
      warning: {
        overExit: (name: string) =>
          `${name} pesa mais do que a saída medida consegue vender no tamanho do seu cofre. Vender pode levar mais tempo.`,
        outsideGoal: (name: string) =>
          `${name} está fora do que seu objetivo normalmente guarda. Está aqui porque você pediu.`,
      },
    },
    review: {
      title: 'Confira esta mistura',
      lead: 'Conferi cada linha de novo com os preços de hoje. Nada foi comprado nem alterado ainda.',
      asset: 'Ativo',
      weight: 'Peso',
      amount: 'Valor',
      price: 'Preço',
      exit: 'O máximo que guarda e ainda sai como planejado',
      total: 'Total revisado',
      cash: 'Caixa',
      cashPrice: 'contado a um dólar',
      measured: 'medido',
      tier: 'pela faixa, não medido',
      warnings: 'Confirme cada um destes',
      left: (n: number) => (n === 1 ? 'Falta confirmar um.' : `Faltam confirmar ${n}.`),
      allTicked: 'Todos os avisos estão confirmados.',
      changed: 'Os números mudaram desde que você olhou. Confira de novo.',
      back: 'Mudar a mistura',
    },
    goal: {
      title: 'Usar esta mistura para um novo objetivo',
      lead: 'Diga quanto e para quê. Confiro a mistura com os preços de hoje antes de qualquer compra.',
      amount: 'Valor',
      amountHint: 'Em dólares, de US$ 10 a US$ 1.000.000.',
      goal: 'Objetivo',
      goals: { grow: 'Fazer crescer', income: 'Renda mensal', protect: 'Manter seguro' },
      risk: 'Risco',
      risks: { low: 'Baixo', medium: 'Médio', high: 'Alto' },
      choose: 'Escolha um',
      review: 'Revisar esta mistura',
      reviewing: 'Revisando…',
      confirm: 'Confirmar e ir para a compra',
      confirming: 'Confirmando…',
      errors: {
        amount: 'Digite um valor de US$ 10 a US$ 1.000.000.',
        goal: 'Escolha para que é o dinheiro.',
        risk: 'Escolha um risco.',
      },
    },
    vault: {
      review: 'Revisar estes pesos-alvo',
      reviewing: 'Revisando…',
      confirm: 'Confirmar e criar a ordem',
      confirming: 'Criando a ordem…',
      after:
        'Em seguida, a tela da ordem mostra cada passo a assinar: primeiro os pesos-alvo, depois as vendas e as compras.',
    },
    editor: {
      title: 'Os pesos do seu cofre',
      lead: 'Escolha o que seu cofre guarda e quanto. O que ficar sem peso fica em caixa.',
      edit: 'Editar pesos',
      weights: 'Pesos',
      fromChat:
        'Estes são os pesos da conversa. Mude qualquer um aqui; os que estiverem nestes campos são os que eu confiro.',
      close: 'Voltar à conversa',
      unit: 'Digitar pesos em',
      percent: 'Porcentagem',
      bps: 'Pontos-base',
      add: 'Adicionar um ativo',
      addButton: 'Adicionar',
      addNone: 'Todos os ativos listados já estão na mistura.',
      remove: (name: string) => `Remover ${name}`,
      weight: (name: string) => `Peso de ${name}`,
      cash: (share: string) => `Caixa: ${share}`,
      lines: (n: number) => `${n} de 16 ativos`,
      issues: {
        'too-many': 'Um cofre guarda 16 ativos além do caixa. Remova um.',
        duplicate: 'Cada ativo uma vez. Remova a repetição.',
        'cash-line': 'O caixa é o que os outros deixam. Remova-o como linha.',
        'not-whole': 'Use porcentagens com até duas casas decimais, ou pontos-base inteiros.',
        'over-whole': (over: string) => `Os pesos somam mais que o todo. Tire ${over}.`,
        'all-cash': 'Dê peso a pelo menos um ativo: um cofre guarda um ativo próprio.',
      },
      loading: 'Lendo seu cofre…',
      notYours: 'Este cofre não é seu, ou não está lá.',
      failed: 'Não consegui ler este cofre agora. Tente de novo.',
      back: 'Voltar ao seu cofre',
    },
    failure: {
      invalid: 'Não consigo usar esta mistura assim:',
      signedOut: 'Seu acesso expirou. Entre de novo e tente mais uma vez.',
      noWallet: 'Seu acesso não tem carteira nesta rede. Adicione uma e tente de novo.',
      notYours: 'Este cofre não é seu.',
      readOnly: 'Esta rede só lê por enquanto. Nada pode ser comprado ou alterado nela.',
      busy: 'Muitos pedidos agora. Espere um pouco e tente de novo.',
      unreadable: 'A resposta não bateu com o pedido. Nada foi guardado. Tente de novo.',
      unchecked:
        'O servidor recebeu sua confirmação, mas a resposta não bateu com o que você revisou, então parei aqui. Pode já estar guardado: veja seu portfólio antes de tentar de novo.',
      unreachable: 'Não consegui falar com o servidor. Nada foi guardado. Tente de novo.',
      said: (error: string) => `O servidor disse: ${error}`,
      noStore:
        'Este navegador não guardou a ordem, então ela não pode ser assinada aqui. Permita o armazenamento do site e tente de novo.',
    },
    issue: (code: string, asset: string) => {
      switch (code) {
        case 'WEIGHT_NOT_WHOLE':
          return 'Um peso não é um número inteiro de pontos-base.';
        case 'NOT_LISTED':
          return `${asset} não está na lista desta rede agora.`;
        case 'DUPLICATE':
          return `${asset} aparece duas vezes.`;
        case 'FOREIGN_CASH':
          return `${asset} é um token de caixa que esta rede não usa. Deixe o caixa como o restante.`;
        case 'SUM_NOT_10000':
          return 'Os pesos não somam o todo.';
        case 'TOO_MANY_LINES':
          return 'Um cofre guarda 16 ativos além do caixa.';
        case 'NO_PRICE':
          return `${asset} não tem um preço usável agora.`;
        case 'NOT_FOR_GOAL':
          return `${asset} não entra em um plano de renda mensal nem de manter o dinheiro seguro: pode perder valor. Tire-o ou escolha outro objetivo.`;
        case 'ALL_CASH':
          return 'Um cofre aberto guarda pelo menos um ativo próprio.';
        case 'OVER_ORDER_LIMIT':
          return 'Este cofre vale mais do que uma ordem pode mover.';
        default:
          return 'Uma linha não pode ser usada.';
      }
    },
    order: {
      title: 'Novos pesos-alvo do seu cofre',
      signTargets: 'Assinar e aplicar os pesos-alvo',
      cash: (share: string) => `O restante fica em caixa: ${share}.`,
      fromConversation: 'Proposto na sua conversa e confirmado por você.',
      fromPerson: 'Escolhido por você.',
      note: 'O primeiro passo define estes pesos-alvo na rede; os passos seguintes vendem e compram para chegar a eles, cada um com seu mínimo.',
    },
  },
};
