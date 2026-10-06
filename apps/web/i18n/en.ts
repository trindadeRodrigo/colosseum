// Every sentence a person reads on the product screens, in English. pt.ts holds the same keys in
// Brazilian Portuguese, and the type below is what keeps the two in step.
//
// The voice (voice-and-tone.md): the answer, then the reason, then the risk, then what to do. "You"
// for the person, "I" for the agent, "we" for the company. Sentence case, no exclamation marks, and
// MOCK is the only word in capitals. The product's nouns: goal, limits, plan, portfolio, exit plan,
// rebalance. Nothing here promises a return or reads as advice; the disclaimer is not here at all,
// it comes from the one DISCLAIMER constant.

export const en = {
  shell: {
    skip: 'Skip to content',
    nav: 'Main',
    home: 'tenonfi, your goal',
    goal: 'Goal',
    portfolio: 'Portfolio',
    analytics: 'Analytics',
    signIn: 'Sign in',
    signOut: 'Sign out',
    signingOut: 'Signing out…',
    /** Said to a screen reader once the person is signed out. */
    signedOut: 'You’re signed out.',
    signOutFailed: 'I couldn’t sign you out: the sign-in service didn’t answer. Try again.',
    account: 'Your wallet',
    disclaimer: 'Disclaimer',
    appearance: 'Appearance',
    themes: { auto: 'System', light: 'Light', dark: 'Dark' },
    language: 'Language',
    /** Beside a figure or a name that comes from a test network, after the MOCK plate. */
    testNetwork: 'test network',
    /** When the server answers that it is being asked too often. */
    slowDown: 'Our server asked me to slow down. Wait a minute, then try again.',
    mockAnnounce: ': sample data, not live',
  },

  signIn: {
    title: 'Sign in with a wallet that is yours.',
    lead: 'Your plan sits in a vault only you can withdraw from, so it needs a wallet you own. Create one with a passkey, or connect one you already use.',
    loading: 'Loading sign-in…',
    passkey: {
      title: 'Passkey',
      body: 'No seed phrase to write down. Your device keeps the passkey, and a wallet is made for you that only it opens.',
      create: 'Create a passkey',
      use: 'Use a passkey I already have',
      waiting: 'Waiting for your passkey…',
      making: 'Making your wallet…',
    },
    wallet: {
      title: 'Wallet',
      body: 'Connect a wallet you already use. Your plan lives on its chain: Solana for a Solana wallet, Robinhood Chain for an Ethereum wallet.',
      /** The name of the list of wallets found in this browser. */
      found: 'Wallets found in this browser',
      family: { solana: 'Solana', evm: 'Ethereum' },
      waiting: 'Waiting for your wallet…',
      none: 'No wallet was found in this browser. Install one, open this page inside your wallet’s own browser, or use a passkey.',
    },
    off: {
      api: 'Sign-in is off for the moment: our server isn’t answering. I ask again every few seconds, and this page updates by itself.',
      setup:
        'Sign-in is off here: this copy of the app isn’t set up correctly. There is nothing for you to fix. Please tell us.',
      /** Before the detail the team needs, shown under `next dev` only. */
      detail: 'For the team',
    },
    failure: {
      passkeyOff:
        'Passkeys aren’t switched on for this app yet, so none can be created or used here. Connect a wallet instead, or come back later.',
      passkeyNotCreated:
        'The passkey wasn’t created: the prompt was closed or ran out of time. Nothing was saved. Try again when you’re ready.',
      passkeyNotUsed:
        'No passkey was used: the prompt was closed or ran out of time. If you have no passkey for this site yet, create one.',
      passkeyUnknown: 'I don’t know that passkey. Create a new one, or connect a wallet.',
      /** Privy's `passkey_not_registered`: the passkey picked was made for another site or app. */
      passkeyNotRegistered: 'That passkey isn’t registered here. Pick another, or create one.',
      /** Privy's `max_accounts_reached`. */
      accountsFull:
        'This app can’t take new accounts right now. Use a passkey or wallet you’ve signed in with before, or come back later.',
      /** Privy's `allowlist_rejected`. */
      notInvited:
        'This app is open to invited people only for now, and this sign-in isn’t on the list. Ask the team for an invite.',
      /** Privy's `session_storage_unavailable`: a private window, or storage blocked. */
      noStorage:
        'This browser is blocking the storage a sign-in needs, as a private window does. Open the page in a normal window, then try again.',
      passkeyUnsupported:
        'This browser can’t use passkeys. Open the page in a current browser, or connect a wallet.',
      walletOff:
        'Wallet sign-in isn’t switched on for this app yet. Use a passkey instead, or come back later.',
      walletRefused:
        'Your wallet declined the request, so nothing was signed and you aren’t signed in. Try again and approve it in the wallet.',
      walletSilent: 'That wallet didn’t answer. Open it, sign in to it, then try again.',
      walletGone:
        'That wallet is no longer in this browser. Pick one from the list, or use a passkey.',
      tooMany: 'Too many tries in a short time. Wait a minute, then try again.',
      offline: 'I couldn’t reach the sign-in service. Check your connection, then try again.',
      expired: 'That took too long and ran out of time. Try again.',
      walletNotMade:
        'You’re signed in, but your wallet couldn’t be made. Nothing is lost. Try again.',
      other:
        'That didn’t work, and I can’t tell why. Try again. If it keeps happening, tell us what you were doing.',
    },
    done: {
      title: 'You’re signed in.',
      noWallet: 'No wallet of yours is connected in this browser.',
      next: 'Go to your goal',
      retryWallet: 'Make my wallet',
    },
  },

  chain: {
    names: { solana: 'Solana', robinhood: 'Robinhood Chain', base: 'Base' },
    pick: {
      title: 'Choose the chain your plan lives on',
      /** Why this person is asked: they made their wallet here, or connected wallets of both kinds. */
      asked: {
        made: 'You made your wallet here, so you choose its chain, once.',
        connected:
          'You connected wallets on two chains, so you choose which one your plan lives on, once.',
      },
      body: 'Your deposit, your vault and every trade of your plan stay on that chain. Each chain has its own shelf of assets, and a plan is built only from the shelf of its chain: it is never split across two.',
      warning: 'This can’t be changed later.',
      group: 'The chain of your plan',
      /** Under a choice: the address the plan will use there. */
      address: (address: string) => `Your wallet there: ${address}`,
      confirm: (chain: string) => `My plan lives on ${chain}`,
      confirmNone: 'Choose a chain',
      saving: 'Saving your choice…',
      why: 'Choose a chain to continue.',
      /** A chain the person holds a wallet for, and our server has switched off: it is not offered. */
      off: (chain: string) =>
        `${chain} is switched off on our server for now, so it can’t be chosen.`,
      noneOn: 'No chain can be chosen right now. Nothing is lost: come back later.',
      /** The throwaway wallet of development: nothing is stored on the server. */
      mock: 'The throwaway wallet has no account on our server, so this choice is kept in this tab only.',
    },
    is: {
      picked: (chain: string) => `Your plan lives on ${chain}. You chose that, and it stands.`,
      wallet: (chain: string) =>
        `Your plan lives on ${chain}, the chain of the wallet you connected.`,
    },
    failure: {
      /** Another device or tab chose first. `stored` is where the plan lives, `tried` what was just chosen. */
      taken: (stored: string, tried: string) =>
        `Your plan already lives on ${stored}: that was chosen before, on another device or in another tab, and it can’t be changed. ${tried} was not saved.`,
      /** The same, when the server has not said yet which chain it was. */
      takenUnknown: (tried: string) =>
        `${tried} was not saved: a chain was chosen for your plan before, on another device or in another tab, and it can’t be changed.`,
      notOffered: 'That chain can’t be chosen with this wallet. Choose the other one.',
      unreachable:
        'I couldn’t save that: our server didn’t answer. Your choice isn’t stored yet. Try again.',
      signedOut: 'Your sign-in ran out before the choice was saved. Sign in again, then choose.',
      /** The API answered 401 because the identity token was not sent: the sign-in service didn't give one. */
      noIdentity:
        'I couldn’t save that: the sign-in service didn’t give me the part of your sign-in that lists your wallets, so our server can’t check them. Your choice isn’t stored yet. Wait a minute, then try again.',
    },
    unknown: {
      body: 'I can’t tell yet which chain your plan lives on: our server didn’t answer. Nothing is wrong with your wallet.',
      retry: 'Ask again',
      asking: 'Asking…',
      /** The API answered 401: it does not know this sign-in any more. */
      signedOut:
        'Our server doesn’t recognise your sign-in any more, so I can’t tell which chain your plan lives on. Sign out, then sign in again.',
      /** The API answered 401 because the identity token was not sent, even after asking for a new one. */
      noIdentity:
        'I can’t tell yet which chain your plan lives on: the sign-in service didn’t give me the part of your sign-in that lists your wallets, so our server can’t check them. Nothing is wrong with your wallet. Wait a minute, then ask again.',
    },
    noWallet:
      'You’re signed in, but no wallet is linked to this sign-in yet, so there is no chain for your plan.',
    reading: 'Reading where your plan lives…',
  },

  goal: {
    title: 'What does your money need to do?',
    lead: 'Say it in a sentence: how much you’re starting with, for how long, and how much risk you’ll take. I read it into limits you can check and change. Nothing is built until you say so.',
    composer: {
      label: 'Your goal',
      placeholder: 'Describe your goal… an amount, a date, and how fast you might need it back.',
      hint: 'Enter to read it · Shift+Enter for a new line',
      submit: 'Read my goal',
      busy: 'Reading your goal…',
    },
    /** Under the box, for a visitor: where a plan of their own comes from. */
    visitor: {
      before: 'Like how it reads?',
      link: 'Sign in',
      after: 'for a plan on the chain of your wallet, with every number sourced.',
    },
    examples: {
      label: 'Examples',
      list: [
        'Grow $2,000 for ten years, high risk',
        'Protect $50,000 for 18 months, low risk',
        '$80,000 for $300 a month of income',
      ],
    },
    readFailure: {
      unreachable:
        'I couldn’t reach our server to read that. Your text is still here. Try again in a moment.',
      tooShort: 'That’s too short for me to read. Try an amount and a time frame.',
      tooLong: 'That’s too long for me to read. Keep it under 2,000 characters.',
      unreadable: 'I got an answer I couldn’t read. Your text is still here. Try again.',
    },
    /** Under the sheet's title, while the only reader is the one made for goals in reais. */
    readerNote:
      'Today’s reader was made for goals in reais, so it can miss a dollar amount or a date. Check each field: what it didn’t find is left empty for you.',
    /** The same note, naming what the reader left empty: "Amount (dollars), Time frame (months)". */
    readerMissed: (fields: string) =>
      `Today’s reader was made for goals in reais, so it didn’t find these in your goal: ${fields}. Fill them in below. Nothing is built until every field fits.`,
    sheet: {
      title: 'How I read your goal',
      parser: 'parser',
      summaryOne: '1 thing doesn’t fit yet. Fix it to build the plan.',
      summaryOther: '{n} things don’t fit yet. Fix them to build the plan.',
      /** For fields with nothing in them yet, as right after a goal is read. */
      missingOne: '1 thing is still missing. Fill it in to build the plan.',
      missingOther: '{n} things are still missing. Fill them in to build the plan.',
      goToField: 'Go to field',
      build: 'Build my plan',
      building: 'Building your plan…',
      fixOne: 'Fix the field above to continue.',
      fixOther: 'Fix the {n} fields above to continue.',
      fillOne: 'Fill in the field above to continue.',
      fillOther: 'Fill in the {n} fields above to continue.',
      reading: 'Reading your goal…',
      noPlan: 'No plan fits these limits.',
      editSheet: 'Edit limits',
      edited: 'edited',
    },
    groups: { goal: 'Goal', time: 'Time and risk', shape: 'What shapes the plan', words: 'Words' },
    fields: {
      goal: 'What the money is for',
      income: 'Monthly income (dollars)',
      horizon: 'Time frame (months)',
      risk: 'Risk comfort',
      country: 'Country where you live',
      holdings: 'Count what you already hold',
      glide: 'Move toward dollar yield as the date nears',
      language: 'Language of the explanations',
      amount: 'Amount (dollars)',
    },
    hints: {
      income: 'What you need each month. Leave it empty if you have no figure.',
      horizon: 'From 1 to 480.',
      country: 'You state it. It decides which assets you may hold.',
      holdings: 'The plan fills gaps and avoids doubling up.',
      amount: 'What this plan starts with, from $10 to $1,000,000.',
      /** Before the hint of a field the reader left empty. */
      notFound: 'Not found in your goal: fill it in.',
    },
    captions: {
      income: 'An income plan holds no stock tokens.',
      protect: 'A plan to protect holds no stock tokens: dollar yield, gold and cash only.',
    },
    options: {
      choose: 'Choose',
      goal: { grow: 'Grow it', income: 'Earn income', protect: 'Protect it' },
      risk: { low: 'Low', medium: 'Medium', high: 'High' },
      yes: 'Yes',
      no: 'No',
      language: { en: 'English', pt: 'Português' },
    },
    errors: {
      goal: 'Choose what the money is for.',
      amountEmpty: 'Enter the amount in dollars.',
      amountNumber: 'Enter the amount as a number, like 40000.',
      amountLow: 'Enter at least $10.',
      amountHigh: 'Enter $1,000,000 or less.',
      horizon: 'Enter the time frame in whole months, from 1 to 480.',
      risk: 'Choose how much risk you’re comfortable with.',
      country: 'Choose the country where you live.',
      income: 'Enter the monthly income as a number above zero, or leave it empty.',
      language: 'Choose a language.',
    },
    chain: {
      label: 'Chain',
      note: 'The chain of your wallet. The plan, its vault and every trade stay there.',
      unset: 'Not set',
      unsetNote: 'A plan is built for the chain of your wallet.',
      choose: 'Choose the chain',
      unknown: 'Not known yet',
    },
    blocked: {
      signedOut: 'Sign in to build: a plan is built for the chain of your wallet.',
      chainNotChosen: 'Choose the chain your plan lives on first.',
      chainUnknown:
        'I can’t tell yet which chain your plan lives on, so I can’t build for it. Ask again, above.',
      refused: 'Our server didn’t accept these limits. Check each field, then try again.',
      /** The server answered 401 or 403 to "Build my plan". */
      signInAgain:
        'Our server doesn’t recognise your sign-in any more, so the plan wasn’t built. Sign out, then sign in again.',
      /** The server answered 401 because the identity token was not sent. */
      noIdentity:
        'The plan wasn’t built: the sign-in service didn’t give me the part of your sign-in that lists your wallets, so our server can’t check them. Your limits are kept. Wait a minute, then try again.',
      chainOff: (chain: string) =>
        `${chain} is switched off on our server for now, so I can’t build a plan there. Your limits are kept.`,
    },
    card: {
      sentence: {
        grow: (amount: string, months: string) => `Grow ${amount} over ${months}.`,
        income: (amount: string, months: string) => `Earn income from ${amount} for ${months}.`,
        protect: (amount: string, months: string) => `Protect ${amount} for ${months}.`,
      },
      months: (n: number) => (n === 1 ? '1 month' : `${n} months`),
      unfinished: 'Your goal, as read so far.',
      draftOpen: 'Draft: finish the limits',
      draftSet: 'Draft: limits set, no plan yet',
      edit: 'Edit limits',
    },
    built: {
      unavailable: {
        title: 'Your limits are set. The plan can’t be built yet.',
        body: 'The part of our server that builds a plan from these limits isn’t connected yet. I won’t show a made-up plan in its place. Your limits are kept in this browser tab.',
      },
      unreachable:
        'I couldn’t reach our server to build the plan. Your limits are unchanged. Try again.',
      unreadable:
        'Our server answered with a plan I couldn’t read, so I’m not showing it. Your limits are unchanged. Try again.',
      done: {
        title: 'Your plan is built.',
        /** "Part" is the brand's word for a leg of a plan, as a person reads it. */
        body: (parts: number, chain: string) =>
          `It has ${parts === 1 ? '1 part' : `${parts} parts`} on ${chain}. Nothing was bought.`,
        see: 'See your plan',
      },
    },
  },
  /** The words a provenance pin says, in the language of the view. */
  pin: {
    sourceFor: 'Source for {value}',
    staleSuffix: ', stale, {age}',
    mockSuffix: ', sample data',
    stale: 'stale',
    ageUnknown: 'age unknown',
    missing: 'no source yet',
    provenance: 'Provenance',
    copy: 'Copy source',
    copied: 'Copied',
    kinds: {
      mock: 'MOCK data, not live',
      sandbox: 'test network, not live',
      fixture: 'a fixture, not live',
      prior_dataset: 'an earlier dataset, not live',
    },
    unknownKind: 'not live',
  },

  /** The monitor (/monitor), and the line about it on the home page. */
  portfolio: {
    title: (vaults: number): string =>
      vaults > 1 ? 'What your vaults hold.' : 'What your vault holds.',
    lead: 'Read from the chain your plan lives on, each time you open this page. Nothing here signs or moves anything.',
    chain: 'Chain',
    reading: 'Reading your vault…',
    signedOut:
      'Sign in to see your portfolio. It sits in a vault on the chain of your wallet, and only you can withdraw from it.',
    noChain: 'Choose the chain your plan lives on first: your vault is on that chain.',
    chooseChain: 'Choose the chain',
    throwaway:
      'The throwaway wallet has no account on our server, so there is no vault of it to read.',
    unavailable:
      'This server can’t read vaults yet, so there is nothing to show here. I won’t show made-up holdings in its place.',
    /** The plan's chain did not answer, or is switched off here. */
    down: {
      word: 'Unavailable',
      body: (chain: string) =>
        `${chain} didn’t answer, so I can’t read your vault right now. Not being able to read it moves nothing. Try again in a moment.`,
    },
    unreachable: 'I couldn’t reach our server to read your vault. Try again.',
    unreadable:
      'Our server answered with something I couldn’t read, so I’m not showing it. Try again.',
    signInAgain:
      'Our server doesn’t recognise your sign-in any more, so I can’t read your vault. Sign out, then sign in again.',
    noIdentity:
      'I can’t read your vault yet: the sign-in service didn’t give me the part of your sign-in that lists your wallets. Wait a minute, then try again.',
    again: 'Read again',
    againBusy: 'Reading…',
    empty: (chain: string) =>
      `You have no vault on ${chain} yet. A vault is made when you buy your first plan.`,
    startGoal: 'Start with your goal',
    vault: {
      title: 'Your vault',
      address: 'Vault address',
      value: 'Value',
      cash: 'Cash',
      autoFollow: 'Auto-follow',
      on: 'On',
      off: 'Off',
      /** The vault's weekly loss counter, as a share of its value. */
      lossUsed: 'Keeper losses, last 7 days',
      holdings: 'Holdings',
      onlyCash: 'Only cash so far: nothing has been bought into this vault yet.',
      columns: {
        asset: 'Asset',
        amount: 'Amount',
        price: 'Price',
        value: 'Value',
        weight: 'Weight',
        target: 'Target',
        drift: 'Drift',
      },
      noPrice: 'no price',
      unpriced: (n: number) =>
        n === 1
          ? '1 holding has no price, so the value leaves it out.'
          : `${n} holdings have no price, so the value leaves them out.`,
      pending: (version: number, when: string) =>
        `Version ${version} of the portfolio you follow takes effect on ${when}.`,
      pendingAssets: (assets: string) => `It adds ${assets}, which you haven’t accepted yet.`,
      observed: (when: string) => `Read from the chain on ${when}.`,
      /** The method line in the pin of a vault's whole value. */
      valueMethod: 'holdings read from the vault, times their prices; cash at one dollar',
      /** The method line in the pin of one holding's value, after its price's own method. */
      positionMethod: (method: string) => `${method}; times the amount the vault holds`,
    },
    /** On the home page, under the goal. */
    summary: {
      title: 'Your portfolio',
      worth: (chain: string) => `Your vault on ${chain} is worth`,
      many: (vaults: number, chain: string) => `You have ${vaults} vaults on ${chain}.`,
      see: 'See your portfolio',
    },
  },

  plan: {
    title: 'Your plan',
    signedOut: 'Sign in to see this plan. A plan is one person’s, on the chain of their wallet.',
    missing: {
      title: 'I don’t have this plan in this tab.',
      body: 'A plan is kept in the browser tab that built it, and this one isn’t here. Build it again from your goal: your limits are kept.',
    },
    backToGoal: 'Back to your goal',
    otherChain: (plan: string, yours: string) =>
      `This plan was made for ${plan}, and your plans live on ${yours}. Build it again from your goal.`,
    lead: (chain: string) =>
      `Built for ${chain}, from your limits. Nothing is bought until you review every step and sign it.`,
    holds: 'What it holds',
    sub: (risk: string, chain: string) => `${risk} · on ${chain} · nothing bought yet`,
    riskWord: { low: 'Low risk', medium: 'Medium risk', high: 'High risk' },
    chips: {
      label: 'Your limits',
      goal: 'goal',
      amount: 'amount',
      horizon: 'horizon',
      risk: 'risk',
      chain: 'chain',
    },
    kpi: {
      amount: 'you put in',
      horizon: 'for',
      projected: 'projected a year',
      loss: 'in a bad fall',
      estimate: 'estimate',
    },
    legs: { afterHaircut: 'after haircut', quoted: 'quoted {rate}' },
    exitPlan: 'Exit plan',
    costPrefix: 'cost',
    foot: { sandbox: 'test network, not live', mock: 'sample data, not live' },
    columns: { asset: 'Asset', share: 'Share', amount: 'Amount', why: 'Why' },
    noReason: 'No reason given.',
    projected: 'Projected range a year, not a promise',
    projectedValue: (low: string, high: string) => `${low} to ${high}`,
    basis: (basis: string) => `How it was worked out: ${basis}.`,
    lossInFall: (amount: string) =>
      `In a bad fall, the engine counts a loss of about ${amount} on this plan.`,
    exitUnmeasured: 'Not measured yet, so no cost is shown.',
    exitCost: (cost: string) => `≤ ${cost}`,
    inKind: 'You can also take the tokens themselves out of your vault at any time.',
    risk: {
      title: 'Risk, as our server rolled it up',
      byClass: 'By kind of asset',
      byIssuer: 'By issuer',
      share: 'Share',
      name: 'Name',
      exitQuoted: 'Cost to sell, last quote',
      exitMeasured: 'Cost to sell, worst measured',
      measuredShare: 'Share of the plan measured',
      notMeasured: 'not measured',
    },
    flags: 'What the engine flagged',
    verdict: {
      met: 'The income you asked for is met by this plan, on the engine’s numbers.',
      gap: (gap: string) => `This plan falls short of the income you asked for by ${gap} a month.`,
    },
    buy: 'Buy this plan',
    chainNotReady: (chain: string) =>
      `${chain} isn’t ready for buying yet: its vaults aren’t deployed on this network. Your plan is kept, and can be bought once they are.`,
    chainOff: (chain: string) =>
      `${chain} is switched off on our server for now, so this plan can’t be bought there yet.`,
  },

  trust: {
    title: 'Before your first deposit',
    lead: 'Read this once. It is what you trust when you put money in a vault.',
    unaudited: 'The vault code hasn’t been audited by anyone outside the team.',
    keys: 'The team holds the keys that upgrade the vault code. An upgrade could change what a vault does, so the team could move funds.',
    admin: (address: string) => `The key that upgrades it: ${address}.`,
    keeper: (tolerance: string, loss: string) =>
      `With auto-follow on, our keeper may trade only your plan’s assets, at most ${tolerance} worse than the reference price, and lose at most ${loss} of your vault in a week. Errors in the reference price add to that. You can switch auto-follow off and withdraw at any time.`,
    keeperUnset:
      'The keeper’s limits on this chain aren’t set yet, so auto-follow isn’t offered here.',
    issuers: 'The issuers of stock tokens can pause, freeze or take back their tokens.',
    notUnitedStates: 'This product isn’t for people in the United States.',
    passkey:
      'A passkey that is lost and not synced to another device loses the wallet it opens. Add a second way in once you have deposited.',
    openChecks: (list: string) =>
      `Checks not run yet, so their findings are not in this notice: ${list}.`,
    checks: {
      evm_invariants: 'the vault contracts’ invariants under hostile callers',
      solana_sequences: 'random sequences of the Solana program’s instructions',
      static_analysis: 'static analysis of the programs and contracts',
      robinhood_fork: 'a run on a copy of Robinhood Chain',
      second_rehearsal: 'a second rehearsal on mainnet with the admin key',
    },
    accept: 'I’ve read this and I accept it',
    accepted: 'You’ve accepted this notice in this browser.',
  },

  buy: {
    title: 'Buy your plan',
    lead: (chain: string) =>
      `The whole amount goes into a vault only you can withdraw from, on ${chain}, then buys each asset of the plan.`,
    amount: {
      label: 'Amount (dollars)',
      hint: (planned: string) => `From $10 to $1,000,000. Your plan was built for ${planned}.`,
    },
    funding: {
      title: 'What your wallet needs',
      reading: 'Reading your wallet…',
      cash: (symbol: string) => `Cash to deposit (${symbol})`,
      gas: (symbol: string) => `Network fees (${symbol})`,
      have: 'You have',
      need: 'This buy needs',
      missing: 'Missing',
      ok: 'Your wallet has what this buy needs.',
      short: (chain: string) =>
        `Your wallet is short of what this buy needs. Add what is missing to your wallet on ${chain}, then read it again.`,
      address: (address: string) => `Your address there: ${address}`,
      newVault:
        'This buy opens your vault for this plan, which costs a little more in fees the first time.',
      readAgain: 'Read my wallet again',
      mockFund: 'Add MOCK cash and fees',
      mockFunding: 'Adding…',
      failure: {
        unreachable: 'I couldn’t read your wallet: our server didn’t answer. Try again.',
        unreadable: 'Our server answered about your wallet in a form I couldn’t read. Try again.',
        noPlan: 'Our server doesn’t have this plan. Build it again from your goal.',
        refused: 'Our server didn’t accept this amount. Check it, then try again.',
      },
    },
    review: (amount: string) => `Review the steps to buy ${amount}`,
    reviewing: 'Making your order…',
    blocked: {
      amount: 'Enter an amount from $10 to $1,000,000 to continue.',
      funding: 'Your wallet needs what is missing above before you can continue.',
      trust: 'Accept the notice above to continue.',
      wallet: 'No wallet of yours is signed in on this chain.',
    },
    failure: {
      NOT_FUNDED:
        'Your wallet doesn’t have enough for this buy any more. Read it again, then try again.',
      ASSET_NOT_ELIGIBLE:
        'One asset of this plan can’t be bought on this chain now. Build the plan again from your goal.',
      VERSION_CHANGED:
        'A shared portfolio in this plan changed after the plan was made. Build the plan again from your goal.',
      ORDER_EXPIRED: 'That order ran out of time. Try again.',
      US_PERSON: 'This product isn’t for people in the United States, so the order wasn’t made.',
      RATE_LIMITED: 'Our server asked me to slow down. Wait a minute, then try again.',
      CHAIN_UNAVAILABLE: 'This chain is switched off on our server for now. Nothing was ordered.',
      unreachable: 'I couldn’t reach our server, so no order was made. Try again.',
      unreadable:
        'Our server answered with an order I couldn’t read, so I’m not showing it. Nothing was signed.',
      noPlan: 'Our server doesn’t have this plan. Build it again from your goal.',
      refused: 'Our server didn’t accept this order. Check the amount, then try again.',
      signedOut:
        'Our server doesn’t recognise your sign-in any more. Sign out, then sign in again.',
      noChain: 'Choose the chain your plan lives on first.',
      noStore:
        'This browser keeps nothing between pages, so I can’t keep your order. Allow this site to store data, then try again.',
    },
  },

  order: {
    title: 'Your order',
    loading: 'Reading your order…',
    signedOut: 'Sign in to see this order. An order is one person’s, and only they can sign it.',
    failure: {
      notFound: 'I can’t find this order for you. It may belong to another sign-in.',
      unreachable: 'I couldn’t read your order: our server didn’t answer. Try again.',
      unreadable: 'Our server answered with an order I couldn’t read, so I’m not showing it.',
      retry: 'Read it again',
    },
    elsewhere:
      'This order was made in another browser, so its plan isn’t here to check the steps against. Open it where you made it, or make a new order.',
    review: {
      title: 'Review every step',
      lead: 'Each step is built fresh when its turn comes, checked against what you see here, and only then signed by your wallet. A step that doesn’t match is not signed.',
      deposit: 'Deposit',
      steps: 'Steps',
      expires: 'Sign before',
      spend: (amount: string, asset: string) => `Spend ${amount} on ${asset}`,
      atLeast: (amount: string, asset: string) =>
        `receive at least ${amount} of ${asset}, in its smallest units`,
      atLeastWhole: (amount: string) => `receive at least ${amount}`,
      under: (pct: string) => `${pct} under the quote`,
      noTrades: 'No trade in this step.',
      warnings: 'Our server warns',
      consents: 'What you agree to for this order',
      consent: {
        auto_follow_on:
          'Switch auto-follow on: our keeper trades your vault toward its portfolio, within the limits above.',
        new_asset: 'Accept a version of the portfolio with an asset you don’t hold yet.',
        publish:
          'Publish this portfolio, or take it back, under your name: others can see it and follow it.',
      },
      consentNeeded: 'Tick each agreement above to continue.',
    },
    mismatch: {
      units:
        'I can’t check this order’s amounts: this app has no record of the cash token on this network. Nothing will be signed.',
      deposit:
        'This order doesn’t deposit the amount you asked for, so I won’t offer to sign it. Nothing was signed. Make a new order, and tell us if it happens again.',
      steps:
        'A step of this order moves another amount of cash than its deposit, so I won’t offer to sign it. Nothing was signed. Make a new order, and tell us if it happens again.',
    },
    signAndBuy: (amount: string) => `Sign and buy ${amount}`,
    resume: (amount: string) => `Continue the buy of ${amount}`,
    signing: (n: number, total: number) => `Signing step ${n} of ${total}…`,
    stepsTitle: 'Steps',
    step: (n: number) => `Step ${n}`,
    kind: {
      approve: 'Allow the deposit',
      create_vault: 'Open your vault and deposit',
      deposit: 'Deposit',
      swap: 'Buy',
      set_targets: 'Set your vault’s targets',
      accept_version: 'Accept a new version',
      set_auto_follow: 'Switch auto-follow',
      withdraw: 'Withdraw',
      publish: 'Publish',
      adopt_version: 'Keeper: adopt a version',
      keeper_leg: 'Keeper: trade',
    },
    status: {
      planned: 'Not started',
      built: 'Built, not signed yet',
      sent: 'Sent, waiting for the chain',
      confirmed: 'Confirmed',
      failed: 'Failed',
      expired: 'Ran out of time',
      skipped: 'Skipped',
    },
    phase: {
      building: 'Building…',
      checking: 'Checking it against your review…',
      signing: 'Signing…',
      reporting: 'Sending…',
      landing: 'Waiting for the chain…',
      waiting: 'Waiting…',
      settled: 'Settled',
    },
    explorer: 'explorer',
    signature: 'signature',
    notRetried: '(not retried)',
    link: {
      tx: 'Tx',
      view: 'View transaction {signature} on {explorer}',
      unavailable: 'link unavailable',
    },
    outcome: {
      done: (chain: string) =>
        `Every step is confirmed on ${chain}, as our server reports it. Each step’s transaction is linked beside it.`,
      refused: (step: number) =>
        `I didn’t sign step ${step}: the transaction our server built for it isn’t the step you approved. Nothing was signed for it.`,
      refusedOrder:
        'I didn’t sign anything: this order doesn’t say enough for me to check its steps. Make a new order.',
      refusedWhy: {
        moved:
          'The price moved since you reviewed it, so the step’s minimum is no longer the one you saw. Review a new order.',
        mismatch:
          'Something in it differs from what you approved. Make a new order; if it happens again, tell us.',
        setup:
          'This app can’t check steps on this network yet. Nothing can be signed here for now.',
      },
      check: (code: string) => `Check that failed: ${code}`,
      cancelled: (step: number) =>
        `Your wallet didn’t sign step ${step}, so it wasn’t sent. Nothing moved for it. You can try again.`,
      failed: (step: number) =>
        `Step ${step} reached the chain and failed. It isn’t sent again: a new attempt is yours to ask for, with a new order.`,
      expired:
        'This order ran out of time before every step was signed. Make a new order for the rest.',
      blocked:
        'Another order of this wallet has a transaction that can still land. Finish or cancel that order first.',
      blockedLink: 'Open that order',
      needsReview: (step: number, times: number) =>
        `Step ${step} was signed ${times === 1 ? 'once' : `${times} times`} before and may still arrive. I can’t tell from the chain whether it can, so I won’t sign it again unless you say so. If you approve it again, it may happen twice.`,
      approveAgain: (step: number) => `Sign step ${step} again`,
      waiting: {
        landing:
          'Your order is on its way: a step is sent and the chain hasn’t taken it yet. Look again in a minute.',
        in_flight:
          'Your order is on its way: a step signed before can still land. Look again in a minute.',
        unseen:
          'Your order is on its way: our server hasn’t seen the last step on the chain yet. Look again in a minute.',
        stopped: 'Stopped. What was signed is kept and reported when you continue.',
        unknown_blockhash:
          'The chain node this app reads from isn’t up to date, so nothing was signed. Look again in a minute.',
      },
      lookAgain: 'Look again',
      error:
        'Our server refused or didn’t answer, so the order stopped. What was signed is kept. Try again.',
      tryAgain: 'Try again',
      elsewhere:
        'This order is running in another tab of this browser. Follow it there; nothing was done here.',
      notRunnable: {
        'no-deployment': (chain: string) =>
          `${chain} isn’t ready for buying yet: its vaults aren’t deployed on this network. Nothing was signed.`,
        'no-wallet':
          'No wallet of yours is signed in on this order’s chain, so nothing was signed.',
        'no-store':
          'This browser keeps nothing between pages, so I won’t sign: a step could be signed twice. Allow this site to store data, then try again.',
        'no-lock':
          'This browser can’t keep an order to one tab, so I won’t sign here. Open the page in a current browser.',
        'plan-mismatch':
          'The plan kept for this order is for another chain, so nothing was signed. Make a new order.',
      },
      crashed:
        'Something stopped the order before it finished. What was signed is kept. Try again.',
      newOrder: 'Make a new order',
    },
  },
  /**
   * Bearing's analytics (/analytics/*): Rodrigo's words from his Analytics 2.0, as he wrote them. The
   * sources and methods in a pin's popover are the API's, in English, in both languages.
   */
  bearing: {
    head: 'Bearing · analytics',
    notAdvice: 'Not advice',
    menu: {
      region: 'Analytics pages',
      nav: 'Analytics',
      show: 'Show menu',
      hide: 'Hide menu',
    },
    pages: {
      stocks: {
        label: 'Stocks',
        lede: 'What it costs to leave a stock, and how much the pools can take.',
      },
      commodities: {
        label: 'Commodities',
        lede: 'What it costs to leave gold, and how much the pools can take.',
      },
      stablecoins: {
        label: 'Stablecoins',
        lede: 'How much of each stablecoin is lent out, and how much you could withdraw now.',
      },
      lending: {
        label: 'Lending',
        lede: 'If the collateral had to be sold today, how much of it the pools would take.',
      },
      simulation: {
        label: 'Simulation',
        lede: 'Sell a position now: what you would lose, and the best way out.',
      },
      methodology: {
        label: 'Methodology',
        lede: 'How every figure on these pages is measured, and what it is not.',
      },
    },
    banner: {
      loading: 'Reading the risk API…',
      live: (time: string) => `Live from the collectors, as of ${time}.`,
      unknownTime: 'an unknown time',
      now: (regime: string, et: string) => `now: ${regime} (${et})`,
      stale: (when: string, age: string) =>
        `The collectors’ newest reading is from ${when}, ${age} old.`,
      unknownAge: 'of an unknown age',
      noReading: 'The collectors have no reading yet.',
      staleAll: 'Every figure is stale: measured, only old. Its age is beside it.',
      down: (api: string) => `The risk API at ${api} did not answer.`,
      downAll: 'Every figure on this page waits for it; none is made up in its place.',
    },
    regimes: {
      us_market_hours: 'market hours',
      us_offhours_weekday: 'off-hours',
      weekend: 'weekend',
      us_holiday: 'holiday',
    },
    reasons: {
      no_samples_in_regime: 'no samples in this regime yet',
      insufficient_samples: 'too few samples to fit',
      beyond_measured_size: 'beyond the largest size measured',
      no_reference_price: 'no reference price',
      no_external_source: 'no external source for this',
      chain_not_covered: 'chain not covered',
      not_collected: 'not collected yet',
      not_imported: 'not imported yet',
      not_followed: 'not followed',
      before_routed_curves: 'from before routed curves',
      gate_open: 'waiting on an open gate',
      not_applicable: 'does not apply here',
      not_served: 'not served by the API',
      api_error: 'the API returned no answer',
      nothing_selected: 'nothing selected',
      no_price_source: 'no price source',
    },
    filter: {
      all: (n: number) => `All (${n})`,
      none: 'None',
      some: (n: number, of: number) => `${n} of ${of}`,
      selectAll: 'All',
      selectNone: 'None',
    },
    pie: {
      others: (n: number) => `${n} other pool${n === 1 ? '' : 's'}`,
      point: 'Point at a slice or a row for its value.',
    },
    chart: {
      range: 'Range',
      metric: 'Metric',
      noData: 'No data',
      noValue: 'no value',
      fewSamples: 'too few samples',
      zoom: 'Zoom',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      poolPrice: 'Pool price',
      below: (quote: string) => `${quote} (below the price)`,
      above: (asset: string) => `${asset} (above the price)`,
      noUsd: 'no USD price',
      held: (token: string) => `in ${token}`,
      sourceOf: (what: string) => `the ${what}`,
    },
    heat: {
      head: (asset: string, size: string) => `${asset} · sell cost at ${size}, by hour of week`,
      thinnest: (when: string) => `thinnest: ${when}`,
      note: 'Lighter cells cost less to leave on warm black; on paper, darker cells cost less.',
      what: (size: string) => `to sell ${size}`,
      aria: (asset: string, size: string) =>
        `Median sell cost of ${asset} at ${size} by hour of week, Eastern time`,
      meta: (n: string, hours: number, zone: string, at: string) =>
        `USD · n=${n} · ${hours} of 168 hours sampled · ${zone} · method risk-0.3 · as of ${at}`,
      reading: 'Reading the hours…',
      table: 'View as table',
      deepFirst: 'Deepest day first',
      least: 'least depth',
      most: 'most depth',
      legend: (n: number) => `– no sample · bins are quintiles of these ${n} hours`,
      move: 'Move through the hours with the arrow keys.',
      noSample: 'no sample',
      day: 'Day',
      days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    },
    dex: {
      reading: 'Reading the pools…',
      assets: 'Assets',
      pools: 'Pools',
      poolsSub: (n: string) => `${n} pools`,
      summary: (assets: number, pools: number, regime: string) =>
        `${assets} asset${assets === 1 ? '' : 's'} · ${pools} pool${pools === 1 ? '' : 's'} · now ${regime}`,
      metrics: { capacity: 'Exit capacity', tvl: 'TVL over time', liquidity: 'Liquidity' },
      kpi: {
        tvl: 'Pool TVL',
        tvlNote: 'selected pools, read at registration',
        pools: 'Pools',
        poolsNote: (n: string) => `of ${n} on the selected assets`,
        capacity: 'Exit capacity now',
        capacityNote: (regime: string) => `sale at ≤ 1% cost, ${regime}`,
        volume: 'Volume 24 h',
        volumeNote: (to: string) => `to ${to} UTC, the newest swap history`,
        lp: 'Top-3 LP share',
        lpNote: 'largest pool, by position',
      },
      pie: { title: 'TVL by pool', note: 'read when each pool was registered' },
      table: {
        title: 'Assets',
        note: 'Capacity is the largest sale that costs at most 1%, by time of week. Exit capacity is that figure hour by hour. The pool filter narrows TVL, the pie, the pool count and the liquidity chart; capacity is routed across all of an asset’s pools, so it does not change with it. Open an asset to simulate selling it.',
        caption: 'Assets with pools, capacity, volume and LP share',
        asset: 'Asset',
        pools: 'Pools',
        poolsOf: (n: string) => `of ${n}`,
        capacity: {
          us_market_hours: 'Capacity, market hours',
          us_offhours_weekday: 'Capacity, off-hours',
          weekend: 'Capacity, weekend',
          us_holiday: 'Capacity, holiday',
        },
        volume: 'Volume 24 h',
        lp: 'Top-3 LP share',
        spark: 'Exit capacity, 30 d',
      },
      capacity: {
        title: 'Exit capacity at ≤ 1% cost',
        note: (from: string) =>
          `sell and buy side, summed over the selected assets, one point per UTC hour since ${from}, when the routed curves began`,
        firstCurve: 'the first routed curve',
        sell: 'sell (exit)',
        buy: 'buy (entry)',
        aria: 'Exit and entry capacity over time for the selected assets',
        src: 'capacity chart',
        partial: (k: number, n: number) => `(${k} of ${n} assets)`,
      },
      tvl: {
        title: 'TVL over time',
        none: 'the collector records the pool value hour by hour only for the concentrated-liquidity pools that make up the top 80% of registry TVL, and none of the selected pools is one of them. Today’s TVL of the selection is in the counters; exit capacity over time is measured for every asset.',
        reading: (n: number) => `Reading ${n} recorded pool${n === 1 ? '' : 's'}…`,
        recorded: 'TVL over time, recorded pools',
        note: (n: number, of: number, share: string | null) =>
          `${n} of ${of} selected pools are recorded hourly${share ? `, holding ${share} of the selection’s TVL` : ''}; the value of the tokens their liquidity holds, uncollected fees not counted. A pool not recorded in an hour keeps its last value for up to 6 h. Recordings began 2026-10-01.`,
        value: 'pool value',
        valueLegend: 'pool value (TVL)',
        held: 'of which in the asset',
        heldLegend: 'of which held in the asset',
        aria: 'Value held by the recorded pools over time',
        src: 'TVL chart',
        partial: (k: number, n: number) => `(${k} of ${n} pools)`,
      },
      liquidity: {
        title: 'Liquidity by price band',
        none: 'none of the selected pools is a concentrated-liquidity pool; a constant-product pool spreads its liquidity over every price.',
        reading: 'Reading the pool…',
        both: 'Liquidity by price band, both sides',
        failed: (error: string) =>
          `${error}. The collector records only the pools that make up the top 80% of registry TVL; pick one without “not recorded”, or wait for the live read.`,
        recordedAt: (at: string) => `the collector’s newest hourly recording, ${at} UTC`,
        liveAt: (at: string) => `read live ${at} UTC`,
        note: (when: string) =>
          `held within ±30% of the price, from ${when}; the asset waits above the price (sold into as it rises), the quote below (bought with as it falls); + and − zoom`,
        aria: (pool: string) => `Liquidity of pool ${pool} by price band around the pool price`,
        src: 'distribution chart',
        pool: 'Pool',
        option: (label: string, tvl: string, recorded: boolean) =>
          `${label} · TVL ${tvl}${recorded ? '' : ' · not recorded'}`,
        quoteNotNamed: 'quote not named',
        asset: 'asset',
        quote: 'quote',
      },
    },
    lending: {
      reading: 'Reading the lending pools…',
      pricing: 'Pricing the collateral…',
      pools: 'Lending pools',
      collateral: 'Collateral',
      summary: (n: number, regime: string) => `${n} pool${n === 1 ? '' : 's'} · now ${regime}`,
      tolerance: 'Tolerance',
      toleranceTitle:
        'A sale counts as covered when it costs at most this, fees and price impact included',
      toleranceError: 'Between 0.1% and 10%',
      metrics: { covered: 'Covered', tvl: 'TVL over time', liquidity: 'Liquidity' },
      kpi: {
        supplied: 'Supplied',
        borrowed: 'Borrowed',
        collateral: 'Collateral posted',
        collateralNote: 'selected assets',
        covered: 'Covered now',
        coveredNote: (tol: string, regime: string) => `sold at ≤ ${tol} cost, ${regime}`,
        largest: 'Largest sale within tolerance',
        largestNote: (tol: string) => `${tol} tolerance`,
        loss: 'Loss if all is sold',
        lossNote: (share: string) => `${share} of the collateral`,
      },
      pie: {
        title: 'Supplied by pool',
        note: 'Kamino: the token supplied; Jupiter Lend vaults: the collateral deposited',
      },
      covered: {
        title: (tol: string) => `Covered and not covered, ${tol} tolerance`,
        note: (from: string) =>
          `today’s collateral against each hour’s exit capacity, as a share of 100%; hours where a collateral asset has no measurement are left out. The counter above reads the curve fitted over the whole time of week; this chart reads each hour’s own snapshot, so the two can differ. Hourly routed curves began ${from}.`,
        notCovered: 'not covered',
        covered: 'covered',
        coveredLegend: (tol: string) => `covered: sold at ≤ ${tol} cost`,
        notCoveredLegend: 'not covered: the sale would cost more',
        aria: (tol: string) =>
          `Share of collateral covered by pool depth at ${tol} cost, over time`,
        src: 'covered chart',
      },
      supplied: {
        title: 'Supplied and borrowed',
        note: 'summed over the selected pools: hourly for the last 7 days, the day’s last reading before that',
        supplied: 'supplied',
        borrowed: 'borrowed',
        aria: 'Supplied and borrowed over time',
        src: 'supplied chart',
        partial: (k: number, n: number) => `(${k} of ${n} pools)`,
      },
      avail: {
        title: 'Available to withdraw',
        note: (more: string) =>
          `cash a lender could take out, and the share lent out below; ${more}`,
        jupiter:
          'a Jupiter Lend vault has no figure here (its lent token sits in a shared liquidity layer)',
        available: 'available',
        lent: 'share lent out',
        aria: 'Available to withdraw and share lent out over time',
        src: 'liquidity chart',
      },
      table: {
        title: 'Lending pools',
        note: (tol: string, regime: string) =>
          `Covered is the share of a pool’s collateral the swap pools could buy at a cost of at most ${tol} in the current time of week (${regime}); the rest would sell at a deeper loss. The loss if all is sold is the routed sale of every collateral asset at its full size, at once. In a row, each lending pool is counted on its own; in the counters and the chart, every position in one stock is added up first and sold into that stock’s pools once, since they draw on the same depth. Kamino reports collateral per market, so reserves of one market show the same collateral; the counters and the chart count it once.`,
        caption: 'Lending pools with coverage of their collateral',
        pool: 'Pool',
        explorer: (pool: string) => `View ${pool} on Solscan`,
        supplied: 'Supplied',
        available: 'Available now',
        jupiterAvailable: 'the vault’s lent token sits in the shared Jupiter Lend liquidity layer',
        lent: 'Share lent out',
        top1: 'Top-1 lender share',
        collateral: 'Collateral',
        assets: (n: number) => `${n} assets`,
        covered: 'Covered',
        largest: 'Largest sale within tolerance',
        loss: 'Loss if all is sold',
        lossShare: (share: string) => `${share} of it`,
        spark: 'Covered, 30 d',
      },
      market: (id: string) => `market ${id}`,
    },
    stable: {
      reading: 'Reading the stablecoin reserves…',
      coins: 'Stablecoins',
      reserves: 'Reserves',
      summary: (n: number) => `${n} reserve${n === 1 ? '' : 's'}`,
      metrics: { tvl: 'TVL over time', liquidity: 'Liquidity' },
      kpi: {
        supplied: 'Supplied',
        borrowed: 'Borrowed',
        available: 'Available now',
        availableNote: 'what lenders could withdraw',
        lent: 'Share lent out',
        reserves: 'Reserves',
        reservesNote: 'Kamino lending reserves',
      },
      pie: 'Supplied by reserve',
      supplied: {
        title: 'Supplied and borrowed',
        note: 'hourly for the last 7 days, the day’s last reading before that',
        aria: 'Stablecoin supplied and borrowed over time',
      },
      availNote: 'summed over the selected reserves',
      table: {
        title: 'Stablecoins',
        note: 'Measured where the collectors read them today: the Kamino lending reserves that lend them. A lender exits by withdrawing, so “available now” takes the place of exit capacity. Swap pools for stablecoins and the yield-bearing ones (USDY, syrupUSDC) are measured once item 17 lands.',
        caption: 'Stablecoins by lending reserve',
        asset: 'Asset',
        reserves: 'Reserves',
        supplied: 'Supplied',
        available: 'Available now',
        lent: 'Share lent out',
        volume: 'Volume 24 h',
        top1: 'Top-1 lender share',
        spark: 'Available, 30 d',
        largest: 'largest reserve',
      },
    },
    sim: {
      reading: 'Reading the assets…',
      asset: 'Asset to sell',
      amount: 'Amount, USD',
      simulate: 'Simulate',
      amountError: 'Enter an amount between $100 and $1,000,000,000, for example 250000 or 250k.',
      pricing: (n: string, id: string) => `Pricing ${n} of ${id}…`,
      kpi: {
        sale: 'Sale',
        saleNote: (id: string) => `${id}, your input`,
        now: 'Time of week now',
        capacity: 'Exit capacity now',
        capacityNote: 'sale at ≤ 1% cost',
        loss: 'Loss on the best path',
        lossNote: (share: string) => `${share} of the sale`,
      },
      verdict: {
        none: (n: string, id: string, why: string) =>
          `No measured route prices ${n} of ${id} right now: ${why}. The simulation never extends a curve past what was measured.`,
        best: (
          n: string,
          id: string,
          path: string,
          atLeast: boolean,
          loss: string,
          share: string,
        ) =>
          `Best path for ${n} of ${id} now: ${path}. It loses ${atLeast ? 'at least ' : ''}${loss} (${share})`,
        against: (loss: string) => `, against ${loss} selling all of it now.`,
        end: '.',
        waits: ' Waiting carries price risk this loss does not count.',
      },
      paths: {
        now: {
          name: 'Sell now across the pools',
          how: 'one routed sale, split across the asset’s dollar pools',
          when: (regime: string) => `now · ${regime}`,
        },
        open: {
          name: 'Wait for market hours',
          how: 'the same routed sale at the next US open; the price can move while you wait',
          when: (wait: string, at: string) => `in ${wait} · ${at}`,
          notFound: 'next open not found',
        },
        split: {
          name: (k: number) => `Split into ${k} hourly sales`,
          how: (k: number, each: string, minutes: string | null) =>
            `${k} sales of ${each}, each within the 1% capacity, one an hour; it assumes the pools refill between sales${
              minutes
                ? ` (after large trades they recovered 90% of depth in a median ${minutes} min)`
                : ''
            }`,
          when: (k: number, regime: string) => `over ${k} h · ${regime}`,
        },
        issuer: {
          name: 'Redeem with the issuer',
          how: (issuer: string, status: string, settles: string) =>
            `${issuer}: ${status}; ${settles}; needs KYC with the issuer`,
          theIssuer: 'the issuer',
          noStatus: 'status not given',
          settles: (days: string) => `settles in ${days} days`,
          noSettle: 'settlement time not given',
          when: (hours: number) => `${hours} open hours in the next 7 days`,
          never: 'no open window in the next 7 days',
        },
      },
      wait: {
        min: (n: string) => `${n} min`,
        h: (n: string) => `${n} h`,
        days: (n: string) => `${n} days`,
      },
      flowTitle: 'Paths, as a flow',
      pathsTitle: 'Paths',
      pathsCaption: 'Ways to sell, with cost and loss',
      head: { path: 'Path', how: 'How', when: 'When', cost: 'Cost', loss: 'Loss' },
      best: 'best',
      capacityNotCost: 'capacity, not a cost',
      neverChosen: 'never chosen over a measured route',
      pathsNote:
        'The best path is the measured one with the smallest loss; on a tie, the one that does not wait. Issuer redemption rests on the issuer’s published terms, a scenario input, so it is shown but never chosen over a measured route.',
      paysTitle: 'What the best path pays',
      parts: {
        poolFee: 'pool fee',
        transferFee: 'transfer fee',
        impact: 'price impact',
        basis: 'basis against the reference',
        platformFee: 'platform fee',
        networkFee: 'network fee',
      },
      byRegimeTitle: 'The same sale by time of week',
      byRegimeCaption: 'Cost by time of week',
      regime: 'Time of week',
      now: 'now',
    },
    flow: {
      region: 'The paths as a flow, scrolls sideways',
      aria: (n: string, id: string) =>
        `Flow of a ${n} sale of ${id} through each path, its pools and payout token, to the dollars received`,
      columns: ['Position', 'Path', 'Pools the sale is split across', 'Paid out in', 'You receive'],
      position: (regime: string) => `your position, ${regime}`,
      received: 'Dollars received',
      receivedSub: 'USDC or USD',
      solHop: 'SOL, swapped to USDC',
      solHopSub: 'a second hop',
      usdOut: 'USDC / USDT',
      usdOutSub: 'paid out by the pool',
      issuer: 'Issuer redemption',
      issuerSub: 'settles T+5, KYC',
      samePools: 'The same pools',
      routed: 'routed',
      noOpenSplit: 'no split simulated in market hours yet',
      noSplit: 'no split for this path',
      assumption: 'assumption',
      notMeasured: 'not measured',
      cost: (c: string) => `cost ${c}`,
      noCost: 'cost not given',
      ofIt: (share: string) => `${share} of it`,
      best: 'best',
      note: (notes: string) =>
        `Each colour is one path; they are alternatives, not one sale. The best path is drawn strongest; issuer redemption is dashed because it rests on the issuer’s terms. Line width follows each pool’s share of the sale. ${notes} Received amounts and losses are the table’s, the fitted cost at the exact size; the split shows where the sale goes.`,
      nearest: (path: string, size: string, when: string) =>
        `${path}: shares from the ${size} simulation, the nearest simulated size, ${when}.`,
      exact: (path: string, when: string) => `${path}: split simulated at this size, ${when}.`,
      fee: (fee: string) => ` · fee ${fee}`,
      tips: {
        into: (n: string, id: string, path: string) => `${n} of ${id} into: ${path}`,
        receive: (path: string, got: string, loss: string, share: string) =>
          `${path}: you receive ${got}, a loss of ${loss} (${share})`,
        leg: (
          path: string,
          share: string,
          amount: string,
          sales: number,
          tokens: string | null,
          pool: string,
        ) =>
          `${path}: ${share} of each sale, ${amount}${sales > 1 ? ` in each of ${sales} sales` : ''}${
            tokens ? `, ${tokens} in all` : ''
          }, into ${pool}`,
        legCost: (path: string, cost: string | null, fee: string | null, quote: string | null) =>
          `${path}: this leg costs ${cost ?? 'an amount not given'} (pool fee ${fee ?? 'not given'}, the rest price impact and basis), paid out in ${quote ?? 'the quote token'}`,
        sol: (path: string, share: string) =>
          `${path}: ${share} of the sale is paid in SOL and swapped to USDC`,
        redeem: (n: string) => `redeem ${n} with the issuer`,
        issuerPays: 'what the issuer pays rests on its published terms, a scenario input',
        same: (path: string, why: string) => `${path}: the same routed sale; ${why}`,
      },
      src: 'flow chart',
    },
    methodology: {
      measured: 'What is measured',
      measuredText:
        'Every 5 minutes we read the on-chain state of each DEX pool that trades a tokenized stock (Raydium CLMM, Orca Whirlpool, Meteora DLMM, Raydium CPMM) and simulate selling and buying the stock for dollars at sizes from $100 to $5M. The simulation reproduces each venue’s swap math from the pool’s own accounts: liquidity at every price level, fees, and Token-2022 transfer fees. It is checked against Jupiter quotes routed through the same pool; the tolerance per venue is part of the test suite.',
      means: 'What a number means',
      meansItems: [
        [
          'Cost',
          '= 1 − dollars received ÷ (size × the pool’s mid price before the trade). It includes the pool fee.',
        ],
        [
          'Capacity at τ',
          '= the largest sale whose cost stays at or below τ (default 1%), from a curve fitted per time-of-week regime: the median cost per size across snapshots, made non-decreasing, interpolated on a log scale. No extrapolation beyond the largest measured size.',
        ],
        [
          'Regimes',
          '(US Eastern time, daylight saving handled): market hours Mon–Fri 09:30–16:00; weekday off-hours; weekend Fri 20:00 → Sun 20:00; NYSE holidays. A holiday with no data uses the weekend curve.',
        ],
        [
          'Weekend ratio',
          '= weekend capacity ÷ market-hours capacity at the same τ. Measured, not assumed.',
        ],
        [
          'LP concentration',
          '= share of liquidity within ±2% of the price held by the largest 1, 3 and 10 positions. The LP-exit stress recomputes the pool without the largest 3.',
        ],
        [
          'Recoverable value',
          '= the better of selling on a DEX in the best regime inside the horizon, and the issuer’s redemption where the window opens and settlement fits inside the horizon. Redemption capacity is a scenario input, labelled assumption; a redemption that settles after the horizon is listed but not counted.',
        ],
        [
          'Liquidity score',
          '= capacity at τ in the worst regime a horizon can contain, divided by a reference size, capped at 1. A number with its inputs beside it, not a grade.',
        ],
        [
          'Breach',
          ': for each upcoming withdrawal, what must come from stock after cash and liquid legs, against a share (default 25%) of the worst-regime capacity inside the withdrawal’s window. Likely breach applies the dry stress: capacity × max(25%, weekend ratio).',
        ],
      ],
      isNot: 'What a number is not',
      isNotItems: [
        'Depth measured in calm markets overstates depth in stress. Every curve shows its regime, sample count and dates.',
        'Curves simulate the best split of a sale across the asset’s dollar-exit pools (USDC, USDT, SOL pools), allocated in 32 chunks to whichever pool pays most for the next chunk. Jupiter quotes are collected every 15 minutes as an independent check; the gap is reported.',
        'Pools quoted in other tokens (not USDC, USDT or SOL) are not counted as exit routes.',
        'Published numbers are asset- and market-level aggregates. No wallet’s positions are published.',
      ],
    },
  },
};

export type Dictionary = typeof en;
