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
    menu: 'Menu',
    invest: 'Invest',
    portfolio: 'Portfolio',
    resources: 'Resources',
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
  /** His guide's "Disclaimer and activity": what was done on chain, beside the disclaimer. */
  activity: {
    notAdvice: 'Not licensed advice',
    title: 'What was done',
    status: {
      built: 'built',
      signed: 'signed',
      sent: 'sent',
      confirmed: 'confirmed',
      failed: 'failed',
    },
    unknownStatus: 'status unknown',
    notRetried: '(not retried)',
    signature: 'transaction id',
    noneYet: 'Nothing has reached the chain from this order yet.',
    noneVault:
      'Nothing this browser placed has reached the chain for this vault. Trades made elsewhere, or by the keeper, are not listed here yet.',
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
      /** The vault's facts as chips, his case's limits line. */
      chips: { label: 'The vault', address: 'address', version: 'version', follow: 'auto-follow' },
      parts: 'Its parts, by weight',
      planTitle: (parts: number) =>
        parts === 1 ? 'Your plan · 1 part' : `Your plan · ${parts} parts`,
      tooMany: 'More parts than a bar can show: each one is in the table below.',
      target: (share: string) => `target ${share}`,
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
    /** The goal card of a vault (guidelines.html, "Goal card and plan"), from the goal its plan was built for. */
    goalCard: {
      onTrack: 'On track',
      offTrack: 'Off track',
      noStatus: 'No status yet: the engine gives one for income goals only',
      unknown: (chain: string) => `Your vault on ${chain}.`,
      notJoined:
        'I can’t tell which goal this vault was bought for: it was bought in another browser, or before this one kept goals. What it holds is below.',
      putIn: (amount: string) => `you put in ${amount}`,
      seePlan: 'See your plan',
      seeOrder: 'See the order',
      startGoal: 'Start with your goal',
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
    /** The chart of the plan pane: the balance the dollar yield projects, from the plan's own range. */
    chart: {
      label: (months: number, low: string, high: string) =>
        `What the dollar yield projects over ${months} months: from ${low} to ${high} a year.`,
      after: (months: number) => `After ${months} months`,
      projected: 'projected',
      low: 'low end',
      high: 'high end',
      note: 'Only what the dollar yield pays is projected. Prices of stocks and gold are not, and can fall.',
      table: 'The projection',
    },
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
  /** His landing page (`/`, hero-3d.html), for a visitor. Every figure on it is MOCK sample data. */
  landing: {
    title: 'Goals, cut to fit',
    description:
      'Tell us what your money needs to do. tenonfi builds the portfolio that gets it there, and shows you how.',
    nav: {
      home: 'tenonfi home',
      main: 'Main',
      menu: 'Menu',
      skip: 'Skip to content',
      products: 'Products',
      invest: 'Invest',
      resources: 'Resources',
      analytics: 'Analytics',
      cta: 'Sign in',
    },
    stage: {
      label: 'How tenonfi fits',
      title:
        'No product fits everyone. So we make the pieces\u00a0— and your goals decide how they fit.',
      taglineStrong: 'Made to measure. Every joint shown.',
      tagline:
        'Tell us what your money needs to do. tenonfi builds the portfolio that gets it there, and shows you how.',
      cue: 'Scroll to see it fit',
      drawing: 'The plan, cut to fit, slides through the goal and seats; the pin goes in last.',
      steps: [
        {
          n: '01 · The pieces',
          title: 'We cut the pieces.',
          body: 'Dollar yield, treasuries, credit, cash: each one measured for what it really pays after risk, and how fast it can be turned back into dollars.',
        },
        {
          n: '02 · The fit',
          title: 'Your goal decides how they fit.',
          body: 'An amount, a date, cash you must be able to reach. The plan is cut to those limits and to no one else’s.',
        },
        {
          n: '03 · The pin',
          title: 'Every joint stays in sight.',
          body: 'Every number carries its source. Every portfolio has an exit plan before the agent invests.',
        },
      ],
    },
    show: {
      label: 'Two goals, cut two ways',
      eyebrow: 'Two goals, two cuts',
      title: 'Same pieces. Different people. Different fit.',
      lead: 'What a plan looks like when it starts from a life, not a product list. Sample plans: every figure below is illustrative.',
      photoCaption: 'placeholder photo · generated',
      sample: 'sample rates, not live',
      estimate: 'estimate',
      sampleUnit: 'sample',
      perMonth: '/ month',
      chips: 'The limits',
      legs: 'How the pieces fit',
      chartTable: 'The chart as a table',
      month: 'Month',
      balance: 'Balance',
      exitPlan: 'Exit plan before investing',
      trip: {
        label: 'Example: a trip in 2029',
        alt: 'A woman with a small backpack walks a coastal cliff trail at golden hour.',
        who: (cash: string) => `Mariana · 31 · paid in ${cash}`,
        quote:
          'I want a savings plan I can reach any day, that pays me $1,000 a month during a three-month trip in 2029.',
        title: 'Trip fund · Jan–Mar 2029',
        sub: 'Low risk · reachable in 1 day · income, so no stocks',
        chips: [
          'target: $1,000/mo × 3',
          'horizon: 27 months',
          'liquidity: 1 day',
          'credit risk: none',
        ],
        kpis: { save: 'you save', for: 'for', earned: 'earned on top', odds: 'odds of funding' },
        months: (n: number) => `${n} months`,
        chart:
          'Monthly balance by part, growing until January 2029, then paying out $1,000 a month for three months.',
        payout: 'trip: $1,000/mo × 3 →',
        legs: [
          { name: (cash: string) => `Cash buffer (${cash})`, why: 'pays the trip months first' },
          { name: () => 'Tokenized treasuries', why: 'dollar yield, next-day redemption' },
          { name: () => 'Dollar lending', why: 'variable rate, instant withdrawal' },
        ],
        exit: 'the whole balance is reachable within a day; the trip months are paid from the cash buffer first.',
        exitNote: 'Sourced live after you connect.',
      },
      growth: {
        label: 'Example: a growth goal with higher risk',
        alt: 'A climber with a rope over his shoulder stands on a granite ridge above the clouds at sunrise.',
        who: 'Diego · 38 · crypto-native',
        quote:
          'Turn $20,000 into $35,000 by 2031 for a season in the mountains. I can live with a 25% drop along the way.',
        title: 'Mountain season · by Dec 2031',
        sub: 'Higher risk · growth · stocks eligible · exits measured by Bearing',
        chips: ['start: $20,000', 'target: $35,000', 'max drawdown: 25%', 'credit risk: accepted'],
        kpis: { add: 'you add', base: 'base case', odds: 'odds of $35k', drop: 'drop budget' },
        maxUnit: 'max',
        chart:
          'Projected balance to 2031 with a base path and a range from a weak to a strong case, against the $35,000 target.',
        goalLine: 'goal $35k',
        weak: 'weak case',
        legs: [
          { name: () => 'Tokenized treasuries', why: 'ballast and the exit of first resort' },
          { name: () => 'Private credit', why: 'higher yield, slower exit (credit risk accepted)' },
          {
            name: (stocks: string) => `Tokenized stocks (${stocks})`,
            why: 'growth part, sized to what Bearing measures can be sold',
          },
          { name: () => 'Tokenized gold', why: 'diversifier, no yield' },
        ],
        exit: 'stocks are sized to what Bearing measures can be sold at the thinnest hour of the week.',
        exitNote: 'Weekend exits are slower and cost more.',
        oddsNote: 'Odds are estimates.',
      },
    },
    sim: {
      label: 'Try your own goal',
      eyebrow: 'Try it · no wallet needed',
      title: 'Tell us what your money needs to do.',
      lead: 'Describe a goal in your own words. You’ll see how it’s read and how the pieces would fit, before you connect anything.',
      examples: [
        '$40,000 by June 2028, cash within 7 days',
        '$3,000 a month from 2028',
        'Grow $25,000 over 3 years, I accept credit risk',
      ],
      opening: 'Opening your goal…',
    },
    closing: {
      label: 'Follow along',
      eyebrow: 'Follow along',
      title: 'Built piece by piece. Watch it come together.',
      lede: 'Product updates as new pieces are cut, and a short letter on goals, liquidity and what tokenized assets really pay. No hype, no price calls.',
      photoAlt:
        'Offset timber beams, stacked and interlocked, frame a view of a forest through tall windows.',
      photoCaption: 'stacked offset beams · reference photo',
      email: 'Email address',
      subscribe: 'Subscribe',
      subscribing: 'Subscribing…',
      group: 'What to receive',
      updates: 'Product updates',
      newsletter: 'Newsletter',
      status: {
        rest: 'Sign-ups aren’t open yet: nothing typed here is sent or kept.',
        'invalid-email': 'That email doesn’t look complete. Check for an @ and a domain.',
        'no-option': 'Pick at least one: product updates or the newsletter.',
        submitting: 'Subscribing…',
        success: 'Nothing was sent: sign-ups aren’t open yet, and your address wasn’t kept.',
        already: 'You’re already on the list.',
        error: 'We couldn’t save that just now. Try again in a minute.',
      },
    },
    foot: 'The plans, rates and odds on this page are MOCK sample data. None of them is live.',
  },
};

export type Dictionary = typeof en;
