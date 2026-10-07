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
    home: 'tenonfi home',
    menu: 'Menu',
    invest: 'Invest',
    portfolio: 'Portfolio',
    products: 'Products',
    resources: 'Resources',
    analytics: 'Analytics',
    shelf: 'Shelf',
    signIn: 'Sign in',
    signOut: 'Sign out',
    signingOut: 'Signing out…',
    /** Said to a screen reader once the person is signed out. */
    signedOut: 'You’re signed out.',
    signOutFailed: 'I couldn’t sign you out: the sign-in service didn’t answer. Try again.',
    account: 'Your wallet',
    /**
     * Someone signed in who is still not ready after a quarter of a minute: said in the bar and where
     * the chain would be, with "Try again" and "Sign out". Which side is slow is said when it is known.
     */
    slow: {
      title: 'Sign-in is slow',
      wallets:
        'You’re signed in, but the sign-in service hasn’t handed over your wallets yet. Nothing is lost.',
      server:
        'You’re signed in, but our server hasn’t said yet which chain your plan lives on. Nothing is lost.',
      /** Nobody is known to be signed in: the sign-in service has not loaded at all. */
      service:
        'The sign-in service hasn’t answered yet, so I can’t tell whether you’re signed in. You can still look around.',
      again: 'Try again',
      trying: 'Trying again…',
      /** "Try again" pressed while a step of an order is being signed. */
      held: 'A step of your order is being signed. Finish or cancel that step first, then try again.',
    },
    /** The account menu in the bar: its items under the chains. */
    address: 'Address',
    copyAddress: 'Copy address',
    copied: 'Copied',
    viewOn: (explorer: string) => `View on ${explorer}`,
    disclaimer: 'Disclaimer',
    appearance: 'Appearance',
    themes: { auto: 'System', light: 'Light', dark: 'Dark' },
    language: 'Language',
    /** Beside a figure or a name that comes from a test network, after the MOCK plate. */
    testNetwork: 'test network',
    /** A card whose figures are read from a test network says only that: they are not samples. */
    testNetworkLine: 'Test network',
    /** When the server answers that it is being asked too often. */
    slowDown: 'Our server asked me to slow down. Wait a minute, then try again.',
    /** A sample card's one quiet line (MOCK-QUIET). */
    mockAnnounce: 'Sample figures',
    /** A sample glyph's name for a screen reader. */
    sampleFigure: 'sample figure',
    /** A wait for data (components/ui/Skeleton.tsx). */
    wait: {
      slow: 'Waking the data service: this can take up to a minute the first time.',
      over: 'Our server didn’t answer in time, so nothing is shown here yet.',
      retry: 'Try again',
    },
  },

  signIn: {
    title: 'Sign in with a wallet that is yours.',
    lead: 'Your plan sits in a vault only you can withdraw from, so it needs a wallet you own. Create one with a passkey, or connect one you already use.',
    loading: 'Loading sign-in…',
    /** The landing's sign-in panel did not load. */
    notLoaded: 'Sign-in didn’t load here.',
    openPage: 'Open the sign-in page',
    /** The button that closes the sign-in dialog. */
    close: 'Close sign-in',
    passkey: {
      title: 'Passkey',
      body: 'No seed phrase to write down. I use the passkey this device keeps for this site. A wallet is made for you that only that passkey opens.',
      /** One button: signs in with a passkey this device has, or makes one. */
      continue: 'Continue with a passkey',
      /** After the prompt to use one was closed: makes one, and with it a new account. */
      createNew: 'Create a new passkey',
      /** Under that button: what a new passkey is, before one is made by mistake. */
      createNewNote:
        'New here? A new passkey opens a new account with a new, empty wallet. It doesn’t open a wallet you already have.',
      waiting: 'Waiting for your passkey…',
      making: 'Making your wallet…',
    },
    wallet: {
      title: 'Wallet',
      body: 'Connect a wallet you already use. Your plan lives on its chain: Solana for a Solana wallet, Robinhood Chain for an Ethereum wallet.',
      /** Opens the list of wallets found in this browser. */
      connect: 'Connect a wallet',
      /** The name of the list of wallets found in this browser. */
      found: 'Wallets found in this browser',
      waiting: 'Waiting for your wallet…',
      none: 'No wallet was found in this browser. Install one, or open this page inside your wallet’s own browser. Or continue with a passkey: it needs nothing installed.',
      /** A wallet that signs on both families: the chain is asked before it signs. */
      both: (wallet: string) =>
        `${wallet} works on Solana and on Robinhood Chain. Choose the chain your plan lives on: it can’t be changed later.`,
      /** After `both`: someone who signed in before chooses again what they chose then. */
      before: 'Signed in before? Choose the chain you chose then.',
      /** A wallet every chain of which is switched off on our server. */
      off: (wallet: string) =>
        `${wallet} works only on chains switched off on our server for now, so it can’t be used to sign in. Use another wallet, or a passkey.`,
      /** The name of the group of the two chains to choose from. */
      chains: 'The chain of your plan',
    },
    /** The sign-in screen when the sign-in service has not loaded after a few seconds. */
    silent: {
      body: 'The sign-in service hasn’t answered yet, so I can’t sign you in right now.',
      offline: 'This device looks offline. Check the connection, then try again.',
      blocked:
        'The sign-in service didn’t answer. A blocker can stop it, or this address may not be set up for sign-in.',
    },
    off: {
      api: 'Sign-in is off for the moment: our server isn’t answering. I ask again every few seconds, and this page updates by itself.',
      setup:
        'Sign-in is off here: this copy of the app isn’t set up correctly. There is nothing for you to fix. Please tell us.',
      /** The sign-in service refuses this page's address (its allowed origins do not list it). */
      origin:
        'Sign-in isn’t set up for this address: the sign-in service takes no sign-in from it. There is nothing for you to fix. Use the site at its own address, or tell us.',
      /** Before the detail the team needs, shown under `next dev` only. */
      detail: 'For the team',
    },
    failure: {
      passkeyOff:
        'Passkeys aren’t switched on for this app yet, so none can be created or used here. Connect a wallet instead, or come back later.',
      passkeyNotCreated:
        'The passkey wasn’t created: the prompt was closed or ran out of time. Nothing was saved. Try again when you’re ready.',
      /** The prompt to use a passkey was closed: nothing is made unless the person asks (SIGN-IN-FLOW). */
      passkeyNotUsed:
        'No passkey was used. If you made one on another device, use that device or choose “use a phone” in the prompt.',
      passkeyUnknown:
        'I don’t know that passkey: no account here was opened with it. Try the one you signed up with.',
      /** A passkey sign-in that failed with nothing more said: no passkey was taken. */
      passkeyNotAccepted:
        'No passkey for this site was accepted, so you aren’t signed in. Try again with the passkey you signed up with, on the device that has it.',
      /** Privy's `passkey_not_registered`: the passkey picked was made for another site or app. */
      passkeyNotRegistered:
        'That passkey isn’t registered here: it was made for another site or app. Pick the one you signed up with here.',
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
      originRefused:
        'Sign-in isn’t set up for this address: the sign-in service takes no sign-in from it. There is nothing for you to fix. Use the site at its own address, or tell us.',
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
    short: { solana: 'Solana', robinhood: 'Robinhood', base: 'Base' },
    /** The explorer each chain's transaction links open, named beside the link. */
    explorers: { solana: 'Solscan', robinhood: 'Robinhood explorer', base: 'Basescan' },
    /** The bar's chain switcher (gate CHAIN-SWITCH). */
    switch: {
      /** The button's name: what it is, and the chain it shows. */
      current: (chain: string) => `Chain: ${chain}`,
      group: 'Choose a chain',
      /** Signed in: what a switch changes, and what it doesn't. */
      plansStay:
        'New plans are built on the chain you choose. Plans you already have stay on their own chain.',
      /** Signed out: what the chain changes. */
      browsing: 'Shows the shared portfolios of that chain.',
      noWallet: (chain: string) => `The wallet you signed in with doesn’t sign on ${chain}.`,
      off: (chain: string) => `${chain} is switched off on our server for now.`,
      saving: 'Switching…',
      done: (chain: string) => `You’re on ${chain} now.`,
    },
    is: {
      picked: (chain: string) =>
        `New plans are built on ${chain}. You can switch chain from the bar at the top.`,
      wallet: (chain: string) =>
        `New plans are built on ${chain}, the chain of the wallet you connected.`,
    },
    /** Why a switch was not saved. */
    failure: {
      noWallet: (chain: string) =>
        `I couldn’t switch: the wallet you signed in with doesn’t sign on ${chain}.`,
      notOffered: 'That chain can’t be chosen here.',
      unreachable:
        'I couldn’t switch: our server didn’t answer. You’re still on the same chain. Try again.',
      signedOut: 'Your sign-in ran out before the switch was saved. Sign in again, then switch.',
      /** The API answered 401 because the identity token was not sent: the sign-in service didn't give one. */
      noIdentity:
        'I couldn’t switch: the sign-in service didn’t give me the part of your sign-in that lists your wallets, so our server can’t check them. Wait a minute, then try again.',
    },
    unknown: {
      /** Every chain a wallet of theirs signs on is switched off on our server. */
      off: 'Every chain your wallets sign on is switched off on our server for now. Nothing is lost: come back later.',
      /** The API would not start them on the chain asked for (409, 422). */
      refused:
        'Our server didn’t take a chain for the wallets you signed in with, so I can’t build for you yet. Sign out, then sign in again.',
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
        '$80,000 for $300 a month of income, 5 years, low risk',
      ],
      /** The sheet's source line, for an example sent as it is: its limits are the app's own. */
    },
    /** Beside the reader on the sheet's source line, when the words of the goal filled what it left empty. */
    readFailure: {
      unreachable:
        'I couldn’t reach our server to read that. Your text is still here. Try again in a moment.',
      tooShort: 'That’s too short for me to read. Try an amount and a time frame.',
      tooLong: 'That’s too long for me to read. Keep it under 2,000 characters.',
      unreadable: 'I got an answer I couldn’t read. Your text is still here. Try again.',
    },
    /** Under the sheet's title, while the only reader is the one made for goals in reais. */
    /** What the reading left empty, by name: "Amount (dollars) and Time frame (months)". */
    readerMissed: (fields: string) =>
      `I didn’t find these in your goal: ${fields}. Fill them in below.`,
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
      /** The next step for a visitor, in the build button's place: not an error. */
      signInToBuild: 'Sign in to build my plan',
      /** The fold over the limits a first plan seldom needs. */
      more: 'More limits',
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
      /** The country's hint while it is the one this browser's language names, unchanged. */
      countryFromBrowser:
        'Taken from this browser’s language. Change it if you live elsewhere: it decides which assets you may hold.',
      holdings: 'The plan fills gaps and avoids doubling up.',
      amount: 'What this plan starts with, from $10 to $1,000,000.',
      /** Before the hint of a field the reader left empty. */
      notFound: 'Not found in your goal: fill it in.',
      /** A field the goal did not say, filled with a starting value the person can change. */
      assumed: 'Not said in your goal: I assumed this. Change it if it’s wrong.',
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
      note: 'The chain you’re on. The plan, its vault and every trade stay there, even if you switch later.',
      unset: 'Not set',
      unsetNote: 'A plan is built on the chain you’re on.',
      choose: 'Choose the chain',
      unknown: 'Not known yet',
    },
    blocked: {
      chainNotChosen: 'Choose a chain from the bar at the top first.',
      chainUnknown:
        'I can’t tell yet which chain your plan lives on, so I can’t build for it. Ask again, above.',
      refused: 'Our server didn’t accept these limits. Check each field, then try again.',
      /** The goal or a withdrawal is in another currency (gate USD-ONLY). */
      currency:
        'Plans are in dollars for now: the amount and every withdrawal. Give them in dollars, then build again.',
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
      /** An income goal that names what it wants a month. */
      sentenceIncome: (income: string, amount: string, months: string) =>
        `Earn ${income} a month from ${amount} for ${months}.`,
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
    /** The heading of one order's lines on the portfolio: "Buy of $80,000 · Oct 5, 2026, 15:00 UTC". */
    buy: (amount: string, when: string) => `Buy of ${amount} · ${when}`,
    order: (when: string) => `Order · ${when}`,
    follow: (when: string) => `Follow a shared portfolio · ${when}`,
    withdraw: (when: string) => `Withdrawal · ${when}`,
    publish: (when: string) => `Publish a portfolio · ${when}`,
    noneVault:
      'Nothing from your buys has reached the chain yet. The keeper’s trades, and orders about a shared portfolio placed in another browser, are not listed here yet.',
  },
  /** The words a provenance pin says, in the language of the view. */
  pin: {
    sourceFor: 'Source for {value}',
    staleSuffix: ', stale, {age}',
    mockSuffix: ', sample figure',
    stale: 'stale',
    ageUnknown: 'age unknown',
    /**
     * The age said in full in the pin's accessible name: `{n}` the count, `{unit}` its word. Words, not
     * a function: a server component hands these to the pin, and a function cannot cross to the client.
     */
    age: {
      said: '{n} {unit} old',
      minute: ['minute', 'minutes'],
      hour: ['hour', 'hours'],
      day: ['day', 'days'],
    },
    missing: 'no source yet',
    provenance: 'Provenance',
    copy: 'Copy source',
    copied: 'Copied',
    kinds: {
      mock: 'sample data, not live',
      sandbox: 'test network, not live',
      fixture: 'a fixture, not live',
      prior_dataset: 'an earlier dataset, not live',
    },
    unknownKind: 'not live',
  },

  /** The monitor (/monitor), and the line about it on the home page. */
  portfolio: {
    /** A chain of the person's that could not be read this time; the others are shown all the same. */
    chainOut: (chain: string) => `${chain} is unavailable right now.`,
    /** A chain of the person's that this server has switched off: asking again will not help. */
    chainOff: (chain: string) => `${chain} is switched off on our server for now.`,
    /** The person's current chain, which no wallet of this sign-in signs on. */
    notHeld: (chain: string) =>
      `No wallet of this sign-in is on ${chain}, so nothing is read there.`,
    title: (vaults: number): string =>
      vaults > 1 ? 'What your vaults hold.' : 'What your vault holds.',
    lead: 'Read from each chain your plans live on, each time you open this page. Nothing here signs or moves anything.',
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
    /** Vaults on more than one chain: a heading per chain, with what that chain's vaults are worth. */
    group: {
      worth: (vaults: number, chain: string) =>
        vaults > 1
          ? `Your ${vaults} vaults on ${chain} are worth`
          : `Your vault on ${chain} is worth`,
      method: (vaults: number, chain: string) =>
        `your ${vaults} vaults on ${chain}, each valued as shown, added up`,
      /** The one total that adds chains up, and says so. */
      across: (chains: number) =>
        chains === 2 ? 'Across both chains, together' : `Across all ${chains} chains, together`,
      acrossMethod: (chains: number) => `the totals of the ${chains} chains above, added up`,
    },
    vault: {
      title: 'Your vault',
      /** Over a vault left with cash by a buy that stopped after its deposit. */
      unfinished:
        'A buy stopped after its deposit, so more of this vault is cash than its plan holds. The cash is safe here.',
      address: 'Vault address',
      /** The link from a vault's panel to its own page. */
      page: (address: string) => `Open the page of vault ${address}`,
      value: 'Value',
      cash: 'Cash',
      autoFollow: 'Auto-follow',
      on: 'On',
      off: 'Off',
      /** The vault's weekly loss counter, as a share of its value. */
      lossUsed: 'Keeper losses, last 7 days',
      holdings: 'What you hold',
      /** The fold over the vault's own facts: its address, the version it follows, auto-follow. */
      details: 'Details',
      version: 'Version of the portfolio it follows',
      followsNothing: 'It follows no shared portfolio: you set its shares.',
      openPage: 'Open this vault’s page',
      parts: 'Its parts, by weight',
      planTitle: (parts: number) =>
        parts === 1 ? 'Your plan · 1 part' : `Your plan · ${parts} parts`,
      tooMany: 'More parts than a bar can show: each one is in the table below.',
      target: (share: string) => `planned ${share}`,
      onlyCash: 'Only cash so far: nothing has been bought into this vault yet.',
      columns: {
        asset: 'Asset',
        amount: 'Amount',
        price: 'Price',
        value: 'Value',
        weight: 'Share now',
        target: 'Planned',
        drift: 'Difference',
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
      takenOut: 'Taken out, as ordered',
      /** On an EVM chain a step that takes everything can pass over a token: the sum is what was ordered. */
      takenOrdered:
        'This counts what your withdrawals ordered. A token one of them couldn’t move is still in the holdings below.',
      takenOutMethod: (n: number) =>
        `${n === 1 ? '1 token' : `${n} tokens`} withdrawn, each at the reference price when ordered`,
      takenUnvalued: (n: number) =>
        `${n === 1 ? 'One token taken out had' : `${n} tokens taken out had`} no price then, and ${n === 1 ? 'is' : 'are'} not in a sum.`,
      /** The method line in the pin of one holding's value, after its price's own method. */
      positionMethod: (method: string) => `${method}; times the amount the vault holds`,
    },
    /** The goal card of a vault (guidelines.html, "Goal card and plan"), from the goal its plan was built for. */
    goalCard: {
      builtMet: 'On track when the plan was built',
      builtShort: 'Short of its income when the plan was built',
      /** The income plan's verdict in figures: what it paid a month of what was asked. */
      builtPaid: (paid: string, asked: string) =>
        `When this plan was built, it paid ${paid} a month of the ${asked} you asked for.`,
      /** Where no status is known, the one plain line: when the goal is due. */
      due: (date: string) => `Goal date: ${date}`,
      unknown: (chain: string) => `Your vault on ${chain}.`,
      notJoined:
        'This vault has no goal I can read: it was bought from a shared portfolio, which has none, or before plans kept their goal. What it holds is below.',
      /** A vault bought from a shared portfolio: what it follows, by name where this browser knows it. */
      follows: (name: string) => `Your vault follows ${name}.`,
      followsShared: 'It follows a shared portfolio. What it holds is below.',
      seeShared: 'See that portfolio',
      putIn: (amount: string) => `you put in ${amount}`,
      tookOut: 'you took some out since',
      seePlan: 'See your plan',
      seeOrder: 'See the order',
      startGoal: 'Start with your goal',
    },
    /** What a person can do with a vault of theirs, on its card and on its page. */
    actions: {
      label: 'This vault',
      /** A vault with no name and no goal to name it by. */
      unnamed: (chain: string) => `Your vault on ${chain}`,
      addMoney: 'Add money',
      rename: 'Rename',
      newPlan: 'New plan',
      nameLabel: 'Name of this vault',
      nameHint: 'Up to 60 characters. Only you see it.',
      save: 'Save the name',
      saving: 'Saving…',
      cancel: 'Cancel',
      /** Takes the name off: the vault is called by its plan's goal again. */
      clear: 'Remove the name',
      failure: {
        invalid:
          'A name is 1 to 60 characters of plain text. Shorten it, or take out what isn’t text, then save again.',
        signedOut:
          'Our server doesn’t recognise your sign-in any more, so the name wasn’t saved. Sign in again.',
        notYours:
          'Our server doesn’t list this vault as yours, so the name wasn’t saved. Read your portfolio again.',
        unreachable: 'I couldn’t save the name: our server didn’t answer. Try again.',
      },
    },
    /** More money into a vault the person has (/vaults/{chain}/{address}/add). */
    add: {
      title: 'Add money to your vault',
      lead: (chain: string) =>
        `The whole amount goes into this vault on ${chain}, then buys each part at the vault’s targets. Nothing is signed here.`,
      amountHint: 'From $10 to $1,000,000.',
      review: (amount: string) => `Review the steps to add ${amount}`,
      reviewLead: (amount: string, chain: string) =>
        `You’re adding ${amount} to your vault on ${chain}. Next you review every step, then sign each one in your wallet.`,
      missing:
        'I can’t find this vault among yours. Open your portfolio, then choose the vault there.',
      back: 'Back to your portfolio',
      otherWallet: (address: string) =>
        `This vault belongs to another wallet of yours (${address}). Sign in with that wallet to add money to it.`,
      noVault:
        'Our server doesn’t list this vault as yours any more. Read your portfolio again, then try again.',
      /** Auto-follow is on: the add is the deposit alone. */
      keeper:
        'Auto-follow is on for this vault, so this add only deposits the cash. Our keeper buys the vault’s assets with it when it next rebalances this vault.',
      /** The portfolio the vault follows has a version the owner has not accepted. */
      newerVersion: (version: number) =>
        `The portfolio this vault follows has a newer version, version ${version}. This add buys the vault’s current targets; accepting the new version is a separate step.`,
      /** Where the targets an add is held to come from. */
      source: {
        read: (chain: string) =>
          `Read from ${chain} by this app, not from our server: the targets this add buys are the chain’s.`,
        mock: 'Sample chain: there is no chain to read, so the targets are our server’s words, not checked.',
        notRead: (chain: string) =>
          `Not checked against ${chain}: this app has no node of its own to read it from. The targets are our server’s words.`,
        failed: (chain: string) =>
          `I couldn’t read this vault on ${chain}: the node this app reads from didn’t answer, or what our server named isn’t the vault the chain holds. I won’t offer to add money until I can.`,
        missing: (chain: string) =>
          `I read ${chain}, and it holds no such vault for your wallet, so I won’t offer to add money to it.`,
        differs: (chain: string) =>
          `Our server’s answer differs from the targets ${chain} holds for this vault, so I won’t offer to add money now. Read your portfolio again in a moment.`,
        unlisted:
          'This vault has a target on a token this app doesn’t list, so I can’t hold an add to it and won’t offer one.',
      },
    },
    /** On the home page, under the goal. */
    summary: {
      title: 'Your portfolio',
      worth: (chain: string) => `Your vault on ${chain} is worth`,
      many: (vaults: number, chain: string) => `You have ${vaults} vaults on ${chain}.`,
      /** Vaults on more than one chain: counted, never added up across them. */
      manyChains: (vaults: number, chains: string) => `You have ${vaults} vaults, on ${chains}.`,
      see: 'See your portfolio',
    },
  },

  plan: {
    title: 'Your plan',
    signedOut: 'Sign in to see this plan. A plan is one person’s, on the chain of their wallet.',
    fromLink:
      'This plan came from a link: our engine made it from the limits the link carried, which someone else may have set. Check the goal, the amount and the limits above before you buy.',
    missing: {
      title: 'I can’t find this plan for you.',
      body: 'It isn’t a plan made with this sign-in, or it is no longer kept. Build one from your goal: your limits are kept.',
      again: 'Build it again',
    },
    backToGoal: 'Back to your goal',
    /** A plan on a chain no wallet of the person's signs on. */
    unsignable: (plan: string) =>
      `This plan is on ${plan}, and the wallet you signed in with doesn’t sign there. Sign in with a wallet that does, or build a plan from your goal.`,
    /** A plan made before a plan lived on one chain. */
    split:
      'This plan is spread over two chains, and a plan lives on one. Build it again from your goal.',
    lead: (chain: string) =>
      `Built for ${chain}, from your limits. Nothing is bought until you review every step and sign it.`,
    holds: 'What it holds',
    /** Cash, named by its token: "Cash (USDC)". */
    cash: (token: string) => `Cash (${token})`,
    /** The plan in one sentence, from its lines (features/order/plain.ts). */
    summary: {
      head: (amount: string, months: string, risk: string, chain: string) =>
        `${amount} for ${months}, ${risk}, on ${chain}:`,
      headOpen: (amount: string, risk: string, chain: string) =>
        `${amount} with no date set, ${risk}, on ${chain}:`,
      stays: (amount: string, name: string) => `${amount} stays in ${name}`,
      goes: (amount: string, name: string) => `${amount} goes to ${name}`,
      more: (n: number) => (n === 1 ? 'one more part' : `${n} more parts`),
    },
    /** What a bad fall could cost, said in a sentence. */
    badFall: {
      none: 'In a bad fall: you’d lose about $0, since nothing here is stocks, crypto or gold.',
      some: (amount: string) => `In a bad fall: you’d lose about ${amount}, an estimate.`,
    },
    details: 'Details',
    /** Above what the engine left out of the plan, each with its own reason. */
    leftOut: 'Left out of this plan',
    kinds: {
      stock: 'Stocks',
      etf: 'Funds',
      gold: 'Gold',
      commodity: 'Commodities',
      dollar_yield: 'Dollar yield',
      crypto: 'Crypto',
      cash: 'Cash',
      other: 'Other',
    },
    /** The engine's flags, each as a sentence. A flag not here is said by `other`, never as its code. */
    flagWords: {
      ceilingFromTier: (asset: string) =>
        `How much ${asset} may weigh comes from its tier, since its selling cost isn’t measured yet.`,
      coverageFromTier: (asset: string) =>
        `${asset} counts toward your withdrawals at its tier’s limit, since its selling cost isn’t measured yet.`,
      capacityThin: (asset: string) =>
        `${asset} sells cheaply only in small amounts, so the plan holds less of it.`,
      regimeNotMeasured: (asset: string) =>
        `Selling ${asset} at some times of the week isn’t measured yet, and may cost more.`,
      undated: (asset: string) =>
        `The selling cost measured for ${asset} has no date, so it isn’t used.`,
      fxOpen: (currency: string) =>
        `Some of what you owe in ${currency} isn’t held in ${currency}, so a change in the rate can cost you.`,
      noMatchingLeg: (currency: string) =>
        `The plan holds nothing in ${currency} to pay withdrawals in it.`,
      noFx: (currency: string) =>
        `There’s no exchange rate for ${currency} yet, so withdrawals in it aren’t counted.`,
      noQuote: 'There’s no recent price quote for selling all of it yet.',
      withdrawalsShort: 'Not every withdrawal is paid on time with what is set aside.',
      notLive: 'Some figures come from a test network or sample data, not from live markets.',
      /** A flag this app has no sentence for yet: said plainly, once, never as its code. */
      other: 'The plan carries one more note we can’t describe yet.',
      simple: {
        exit_not_measured: 'No part of this plan has a measured selling cost yet.',
        exit_partly_measured: 'Only part of this plan has a measured selling cost.',
        exit_beyond_measured_size:
          'Part of this plan is larger than the largest sale measured, so selling it may cost more.',
        exit_capacity_short:
          'Part of this plan is larger than what can be sold for 1% or less at the worst time measured.',
        exit_cost_below_zero:
          'A measured selling cost came out below zero, and is counted as zero.',
        exit_regimes_not_reported: 'The selling cost isn’t reported for every time of the week.',
        issuer_concentration: 'More than half of the plan is with one issuer.',
        asset_not_on_shelf:
          'A part of the plan isn’t on the list of assets, so it couldn’t be classed.',
        unplaced: 'Some money couldn’t be placed within your limits, and is kept in cash.',
        no_dollar_yield: 'There’s no dollar yield you can hold here, so the rest is kept in cash.',
        safe_yield_no_rate_leg:
          'There’s no token here that pays a rate alone, so the safe part is kept in cash.',
        yield_not_read: 'There’s no yield reading yet, so no projection is shown.',
        liquidity_unsourced: 'A selling cost with no source isn’t used.',
        coverage_moved: 'Money was moved so that your withdrawals are paid on time.',
        obligations_past: 'A withdrawal dated in the past is left out.',
        income_not_estimated: 'The income this plan pays isn’t estimated yet.',
        income_no_amount_closes: 'No larger amount pays the income you asked for.',
      },
    },
    /** A plan this short, or this flat, is said in a sentence instead of a chart. */
    short: (months: string) => `In ${months}:`,
    shortRange: (low: string, high: string) => `about ${low} to ${high}`,
    sub: (risk: string, chain: string) => `${risk} · on ${chain} · nothing bought yet`,
    riskWord: { low: 'Low risk', medium: 'Medium risk', high: 'High risk' },
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
      /** An income plan: what its yield pays out over the term, in all. */
      paid: (months: number) => `Paid out over ${months} months, in all`,
      projected: 'projected',
      low: 'low end',
      high: 'high end',
      note: 'Only what the dollar yield pays is projected. Prices of stocks and gold are not, and can fall.',
      table: 'The projection',
      /** A month of the term, counted from the start, in the readout under the chart. */
      month: (m: number) => (m === 1 ? 'month 1' : `month ${m}`),
      hint: 'Point at the chart, tap it or use the arrow keys to read a month.',
      series: 'What the chart draws',
    },
    exitPlan: 'Exit plan',
    costPrefix: 'cost',
    columns: { asset: 'Asset', share: 'Share', amount: 'Amount', why: 'Why' },
    noReason: 'No reason given.',
    projected: 'Projected range a year, not a promise',
    projectedValue: (low: string, high: string) => `${low} to ${high}`,
    basis: (basis: string) => `How it was worked out: ${String(basis).replace(/[.\s]+$/, '')}.`,
    lossInFall: (amount: string) =>
      `In a bad fall, the engine counts a loss of about ${amount} on this plan.`,
    exitUnmeasured: 'Not measured yet, so no cost is shown.',
    exitCost: (cost: string) => `≤ ${cost}`,
    inKind:
      'You can take the tokens themselves out of your vault at any time. Selling them to cash for you isn’t offered yet.',
    risk: {
      /** On a plan read back from the server, which keeps the plan and not this summary. */
      notKept:
        'How this plan is spread, and what selling it costs, is worked out when a plan is built and isn’t kept with it. Build the plan again from your goal to see it.',
      title: 'How the plan is spread, and what selling costs',
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
      /** Above the ways the engine found to close the gap, each its own sentence. */
      ways: 'To close the gap:',
      change: 'Change my limits',
    },
    /** What an income plan pays a month, from its projected range a year. */
    monthly: {
      /** The figure itself, which carries the pin of the plan's yield reading. */
      figure: (low: string, high: string) =>
        low === high ? `About ${low} a month` : `About ${low} to ${high} a month`,
      /** After it: an estimate, not a promise. */
      after: 'if the projected range holds. An estimate, not a promise.',
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
    /** The four points of the notice in short, with the whole notice one click away. */
    short: {
      title: 'What you’re trusting',
      unaudited: 'The vault code hasn’t been audited outside the team.',
      keys: 'The team holds keys that can upgrade the vault code.',
      keeper: (tolerance: string, loss: string) =>
        `With auto-follow on, our keeper trades within limits: at most ${tolerance} off the reference price, and at most ${loss} of your vault lost in a week.`,
      keeperUnset:
        'The keeper’s limits aren’t set on this chain, so auto-follow isn’t offered here.',
      issuers: 'The issuers of stock tokens can freeze or take back their tokens.',
      full: 'Read the full list',
    },
  },

  buy: {
    title: 'Buy your plan',
    lead: (chain: string) =>
      `The whole amount goes into a vault only you can withdraw from, on ${chain}, then buys each asset of the plan.`,
    amount: {
      label: 'Amount (dollars)',
      hint: (planned: string) => `Your plan was built for ${planned}. From $10 to $1,000,000.`,
      /** Under an amount that is not the plan's: its limits were set in dollars at that amount. */
      other: (planned: string) =>
        `Your plan was built for ${planned}, and its limits were worked out at that amount. To buy another amount, build the plan again for it.`,
    },
    /** The four steps of a buy, one open at a time. */
    steps: {
      label: 'Steps to buy',
      names: { amount: 'Amount', funds: 'Funds', trust: 'Trust', review: 'Review' },
      /** Read after a step's name by a screen reader. */
      done: 'done',
      next: 'Continue',
      funds: { ready: 'Ready', short: 'Something is missing', reading: 'Reading…' },
      trust: { accepted: 'Accepted', open: 'Not accepted yet' },
      reviewLead: (amount: string, chain: string) =>
        `You’re buying ${amount} on ${chain}. Next you review every step, then sign each one in your wallet.`,
      /** The one line over the card when its figures are not live. */
      note: {
        testNetwork: (chain: string) => `Test network · ${chain} · not live`,
      },
    },
    funding: {
      title: 'What your wallet needs',
      /** The need in one line: the deposit, and the fees. */
      needs: (cash: string, gas: string) => `You need ${cash} and ${gas} for fees.`,
      haveNone: 'You have none yet.',
      lacking: (list: string) => `You’re still short ${list}.`,
      and: (a: string, b: string) => `${a} and ${b}`,
      details: 'Show the details',
      testFunds: 'Get test funds',
      testFunding: 'Sending test funds…',
      testNote: 'Test tokens have no value. They exist only on the test network.',
      testSent: (list: string) => `I sent ${list} to your wallet on the test network.`,
      testFailure: {
        busy: 'You’ve had test funds as often as a day allows. Try again tomorrow, or fund the wallet yourself.',
        tooMuch:
          'This amount needs more than one send of test funds gives. Choose a smaller amount, then ask again.',
        enough: 'Your wallet already has what this buy needs.',
        lowCash:
          'Our test funds are low. Ask the team to top them up, or fund the wallet yourself.',
        lowGas: 'Our test gas is low. Ask the team to top it up, or fund the wallet yourself.',
        refused:
          'Our server didn’t send test funds for this buy. Read your wallet again, then try again.',
        unreachable:
          'The test network didn’t take the transfer, or our server didn’t answer. Read your wallet again: part of it may have arrived.',
      },
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
      mockFund: 'Add sample cash and fees',
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
      funding: 'Your wallet needs what is missing before you can continue.',
      trust: 'Accept the notice to continue.',
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

  shared: {
    meta: {
      shelf: 'Shared portfolios',
      family: 'Shared portfolio',
      familyDescription: 'A list of assets and weights its creator published on a chain.',
      publish: 'Publish a portfolio',
      publishDescription: 'Publish your list of assets and weights for others to follow.',
      vault: 'Vault',
    },
    shelf: {
      title: 'Portfolios people have shared.',
      lead: (chain: string) =>
        `Each is a list of assets and weights its creator published on a chain. These are the ones on ${chain}, where your plans live.`,
      leadAll:
        'Each is a list of assets and weights its creator published on a chain. Sign in to see the ones on your chain.',
      loading: 'Reading the shared portfolios…',
      empty: (chain: string) => `No portfolio is shared on ${chain} yet.`,
      emptyAll: 'No portfolio is shared yet.',
      publish: 'Publish a portfolio',
      /** Where publishing is not offered yet: said, in place of the link. */
      publishSoon: (chain: string) =>
        `Publishing a portfolio on ${chain} is coming. For now it can be done on Solana.`,
      /** After signing out on this page: the shelf stays, and says whose it is now. */
      signedOut: (chain: string) =>
        `You’re signed out. This is still the shelf of ${chain}; sign in to follow a portfolio.`,
      card: {
        by: (creator: string) => `by ${creator}`,
        platform: 'From tenonfi',
        version: (n: number) => `version ${n}`,
        waiting: (n: number) => `version ${n} waits`,
        open: (name: string) => `Open ${name}`,
        on: 'on',
      },
      failure: {
        unreachable: 'I couldn’t read the shared portfolios: our server didn’t answer. Try again.',
        unreadable: 'Our server answered with something I couldn’t read, so I’m not showing it.',
        retry: 'Read them again',
      },
    },
    text: {
      unverified:
        'The name and description don’t match what the creator published on the chain, so I can’t vouch for them.',
      pending:
        'The name and description are those of the version that waits. The version in effect was published with other words.',
      creator: 'Created by',
      notChecked:
        'The name and description aren’t checked against what the creator published on the chain.',
    },
    family: {
      loading: 'Reading this portfolio…',
      missing: 'I can’t find a shared portfolio with that name.',
      backToShelf: 'Back to the shared portfolios',
      lead: (chain: string) =>
        `A list of assets and weights its creator published on ${chain}. Following it means a vault of yours takes its weights; a new version takes effect after a delay, and you see it before it does.`,
      notHere: (chain: string) =>
        `This portfolio isn’t published on ${chain}, your current chain, so it can’t be followed from here.`,
      /** A vault of the person's on another chain follows it: it is updated on that chain. */
      elsewhere: (chain: string) =>
        `You have a vault on ${chain} that follows this portfolio. Switch to ${chain} to update it there.`,
      switchTo: (chain: string) => `Switch to ${chain}`,
      recipe: (chain: string) => `On ${chain}`,
      inEffect: 'In effect',
      since: (when: string) => `since ${when}`,
      waits: (n: number, when: string) => `Version ${n} takes effect on ${when}`,
      waitsLead:
        'It was published and isn’t in effect yet. A vault that follows this portfolio moves to it only once it is.',
      versionN: (n: number) => `Version ${n}`,
      versions: 'Every version',
      columns: { version: 'Version', status: 'Status', effective: 'In effect from' },
      status: {
        active: 'In effect',
        pending: 'Waiting',
        superseded: 'Replaced',
        cancelled: 'Taken back',
      },
      buy: 'Buy and follow this portfolio',
      signIn: 'Sign in to follow',
      chainNotReady: (chain: string) =>
        `${chain} isn’t ready for following yet: its vaults aren’t deployed on this network.`,
      tampered: (chain: string) =>
        `I couldn’t verify this portfolio on ${chain}, so I won’t offer to buy or follow it: it may have been tampered with. Try again later.`,
      missingOnChain: (chain: string) =>
        `${chain} has no such portfolio: I read the chain, and the registry doesn’t hold it. It can’t be followed.`,
      unlisted:
        'The chain’s version holds a token this app doesn’t list, so I won’t offer to follow it.',
      notListed: 'a token this app doesn’t list',
      foreign:
        'This portfolio wasn’t published through this app, so I can’t check its id against its name, and following it isn’t offered here yet.',
    },
    check: {
      reading: 'Reading it from the chain…',
      read: (chain: string) =>
        `Read from ${chain} by this app, not from our server: the version and weights shown are the chain’s.`,
      differs: (chain: string) =>
        `Our server’s answer differs from what ${chain} holds. I show the chain’s version and weights, and a follow is held to them.`,
      unverified: {
        mock: 'Sample chain: there is no chain to read, so these are our server’s words, not checked.',
        'no-node': (chain: string) =>
          `Not checked against ${chain}: this app has no node of its own to read it from. These are our server’s words.`,
        'no-reader': (chain: string) =>
          `Not checked against ${chain}: this app doesn’t read ${chain}’s registry yet. These are our server’s words.`,
        'no-deployment': (chain: string) =>
          `Not checked against ${chain}: this app has no record of the tokens on this network. These are our server’s words.`,
        'family-id':
          'Not checked against the chain: this portfolio wasn’t published through this app, so its id comes from our server. These are our server’s words.',
      },
      failed: (chain: string) =>
        `I couldn’t verify this portfolio on ${chain}: the node this app reads from didn’t answer, or what our server named isn’t the portfolio the chain holds. It may have been tampered with, so I won’t offer to follow it.`,
      missing: (chain: string) =>
        `I read ${chain}, and it holds no such portfolio: what’s shown is only our server’s word.`,
      verified: 'Read from the chain',
      notChecked: 'Not checked against the chain',
    },
    offer: {
      title: 'Auto-follow',
      offered:
        'Offered: with auto-follow on, our keeper rebalances a vault that follows this portfolio when a new version takes effect, within the vault’s limits.',
      noOracle: (assets: string, chain: string) =>
        `Not offered: this portfolio holds ${assets}, which has no price oracle on ${chain}, so our keeper can’t rebalance it. If you follow it, I ask you to rebalance, in one tap, when it changes.`,
      switchedOff: (chain: string) =>
        `Not offered on ${chain} yet: our keeper doesn’t run there. If you follow it, I ask you to rebalance, in one tap, when it changes.`,
    },
    buy: {
      title: 'Buy and follow',
      lead: (chain: string) =>
        `A vault of yours on ${chain} follows this portfolio, at the version shown, with auto-follow off. Nothing is bought until you review every step and sign it.`,
      amountHint: 'In dollars, at least $10.',
      blocked: {
        terms: 'I couldn’t read this portfolio, so there is nothing to follow yet.',
        missing: 'The chain doesn’t hold this portfolio, so it can’t be followed.',
        unlisted: 'This portfolio holds a token this app doesn’t list.',
      },
    },
    vaults: {
      title: 'Your vaults',
      none: 'You have no vault on this chain yet. Buy this portfolio to open one that follows it.',
      following: 'Follows this portfolio',
      notFollowing: 'Follows another portfolio',
      /** A vault bought from a goal: it follows no shared portfolio. */
      ownPlan: 'Holds your own plan',
      followWith: 'Follow with this vault',
      followNote:
        'Your vault takes this portfolio’s weights. Nothing is traded in that step: you rebalance after, or the keeper does with auto-follow on.',
      autoOn: 'Switch auto-follow on',
      autoOff: 'Switch auto-follow off',
      autoIs: (on: boolean): string => (on ? 'Auto-follow is on.' : 'Auto-follow is off.'),
      oneTap:
        'This portfolio isn’t rebalanced for you. When it changes, I ask you here to accept the new version and rebalance.',
      address: (address: string) => `Vault ${address}`,
      open: 'Open the vault',
      failure: 'I couldn’t read your vaults: our server didn’t answer. Try again.',
    },
    prompt: {
      title: 'This portfolio changed',
      waits: (n: number, when: string) =>
        `Version ${n} takes effect on ${when}. You can accept it then; until it does, your vault keeps the version it has.`,
      inEffect: (n: number) =>
        `Version ${n} is in effect, and your vault still holds an earlier one. Accept it to take its weights, then rebalance.`,
      newAssets: (assets: string) => `It adds ${assets}, which your vault doesn’t hold yet.`,
      accept: (n: number) => `Accept version ${n}`,
    },
    publish: {
      title: 'Publish a portfolio.',
      lead: (chain: string) =>
        `Your list of assets and weights, under a name, on ${chain}. Anyone can see it and follow it. You sign it with your wallet: I check the transaction against this form before your wallet is asked.`,
      signIn: 'Sign in to publish a portfolio.',
      about: 'Its name and description',
      name: 'Name',
      nameHint: 'Plain letters, digits and punctuation, up to 280 characters.',
      slug: 'Address on the shelf',
      slugHint: 'Lower-case letters, digits and dashes. It can’t change once published.',
      copy: 'Description',
      copyHint: 'Up to 280 characters, with no link.',
      familyId: 'Its id, worked out from the address',
      assets: 'Assets and weights',
      assetsHint: '3 to 12 assets, each from 2% to 50%, in steps of 0.5%, adding up to 100%.',
      asset: 'Asset',
      weight: 'Weight, in %',
      /** The labels of a row's two fields. */
      assetOf: (n: number) => `Asset ${n}`,
      weightOf: (n: number) => `Weight of asset ${n} (%)`,
      add: 'Add an asset',
      remove: (asset: string) => `Remove ${asset}`,
      total: (sum: string) => `Total: ${sum}`,
      update: (n: number) =>
        `You published this portfolio before. This is version ${n}: it takes effect after the publish delay, and a version moves at most 20% of the portfolio.`,
      first: 'This is version 1: it takes effect as soon as it lands.',
      theirs: 'This address belongs to another creator’s portfolio. Choose another.',
      review: 'Review the publish',
      reviewing: 'Making the order…',
      problems: {
        name: 'A name needs plain letters, digits and punctuation, with no space at either end and no link or web address.',
        slug: 'An address needs lower-case letters, digits and dashes.',
        copy: 'A description is at most 280 characters, with no link or web address and no hidden characters.',
        count: 'A portfolio holds 3 to 12 assets.',
        weight: 'Each weight is from 2% to 50%, in steps of 0.5%.',
        sum: 'The weights add up to 100%.',
        twice: 'An asset appears once.',
        chain: 'Publishing isn’t open on this chain yet.',
      },
      failure: {
        said: (error: string) => `Our server said no: ${error}.`,
        unreachable: 'I couldn’t make the order: our server didn’t answer. Try again.',
        unreadable: 'Our server answered with an order I couldn’t read, so I’m not showing it.',
        signedOut: 'Your sign-in ended. Sign in again, and your form is kept.',
        noStore:
          'This browser keeps nothing between pages, so I won’t make the order: a step could be signed twice.',
      },
    },
    vault: {
      title: 'A vault, as its chain holds it',
      lead: (chain: string) =>
        `Read from ${chain} for this page. Anyone can see a vault: what it holds is public on its chain.`,
      loading: 'Reading the vault…',
      missing: 'There is no vault at this address.',
      back: 'Back to your portfolio',
      /** The link to the vault's address on its chain's explorer. */
      explorer: (explorer: string) => `See it on ${explorer}`,
      owner: 'Owner',
      follows: 'Follows',
      followsNothing: 'Nothing: the owner sets its weights',
      autoFollowOff:
        'Auto-follow is off for this vault. To switch it on, open the shared portfolio it follows and choose auto-follow there.',
      autoFollowWhere: 'Shared portfolios',
      version: (n: number) => `version ${n}`,
      autoFollow: 'Auto-follow',
      value: 'Value',
      cash: 'Cash',
      columns: {
        asset: 'Asset',
        held: 'Amount',
        price: 'Price',
        weight: 'Share now',
        target: 'Planned',
        drift: 'Difference',
      },
      on: 'On',
      off: 'Off',
    },
  },

  withdraw: {
    meta: 'Withdraw',
    title: 'Withdraw from your vault',
    lead: (chain: string) =>
      `The tokens leave your vault as they are and go to your own wallet on ${chain}. Nothing is sold.`,
    loading: 'Reading your vault…',
    failed: 'I couldn’t read your vaults: our server didn’t answer. Try again.',
    notYours: 'This isn’t a vault of yours, so there is nothing to withdraw here.',
    empty: 'This vault is empty: nothing is held in it now.',
    back: 'Back to your portfolio',
    action: 'Withdraw',
    steps: {
      label: 'Steps to withdraw',
      names: { what: 'What', check: 'Review', confirm: 'Sign' },
      done: 'done',
      next: 'Continue',
    },
    what: {
      legend: 'What do you want to take out?',
      everything: 'Everything the vault holds',
      some: 'Choose tokens and amounts',
      take: (name: string) => `Withdraw ${name}`,
      holds: (amount: string) => `The vault holds ${amount}.`,
      amount: (symbol: string) => `Amount of ${symbol}`,
      amountHint: 'Leave it empty to take all of it.',
      wholeOnly: 'All of it or none: this app doesn’t know this token’s units.',
      errors: {
        amount: 'Enter an amount of this token, or leave it empty to take all of it.',
        over: (held: string) => `The vault holds ${held}. Enter that much or less.`,
        none: 'Choose at least one token to continue.',
      },
      summaryAll: 'Everything',
      summarySome: (n: number) => (n === 1 ? '1 token' : `${n} tokens`),
    },
    check: {
      leaves: 'What leaves the vault',
      token: 'Token',
      amount: 'Amount',
      all: (held: string) => `All of it: ${held} now`,
      to: 'Goes to',
      own: 'Your own wallet',
      from: 'From your vault',
      onlyOwner:
        'A vault pays only its owner. Your wallet is asked to sign only a withdrawal of exactly these tokens to this address.',
      stays: 'Everything else stays in the vault.',
      emptied: 'The vault will be empty afterwards.',
      autoFollow:
        'Automatic following stops for this vault. Auto-follow is on, and the first step switches it off, so our keeper doesn’t trade the vault while you withdraw or afterwards. To switch it on again, open the shared portfolio this vault follows; the vault’s page links there.',
      noSale:
        'Selling to cash before withdrawing isn’t offered yet; you can withdraw the tokens themselves.',
      seen: 'Reviewed',
      confirm: 'This is what I want to withdraw',
    },
    confirm: {
      lead: 'Next you review each step of the order, then sign it in your wallet. The network fee is paid from your wallet.',
      button: 'Review the steps to withdraw',
      busy: 'Making your order…',
      blocked: {
        what: 'Choose what to withdraw first.',
        check: 'Confirm what leaves first.',
        owner: 'No wallet of yours is signed in on this chain.',
        chain: (chain: string) => `${chain} isn’t ready for signing here yet.`,
        vault:
          'I couldn’t hold this vault to your wallet, so I’m not offering the withdrawal. Nothing was signed.',
      },
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
      /** An order that finishes another with the cash in its vault. */
      continuesLead:
        'This order finishes a buy that stopped: it buys what was left with the cash already in your vault, and deposits nothing. Each step is built fresh, checked against what you see here, and only then signed by your wallet.',
      fromVault: 'From your vault’s cash',
      /** The first order was reviewed in another browser. */
      unseen:
        'This device didn’t see the first order’s review. What is left to buy is as our server lists it, and I hold it to the assets of your plan.',
      deposit: 'Deposit',
      steps: 'Steps',
      expires: 'Sign before',
      spend: (amount: string, asset: string) => `Spend ${amount} on ${asset}`,
      /** Where this app has no units for the token: how far under the quote the step may land. */
      atMostUnder: (pct: string) => `at most ${pct} under the quote`,
      atLeastWhole: (amount: string) => `receive at least ${amount}`,
      /** The most a token costs at that minimum: what is spent over the least received. */
      atMostEach: (price: string) => `at most ${price} each`,
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
      trades:
        'This order spends your deposit on other weights than the portfolio you reviewed, so I won’t offer to sign it. Nothing was signed. Make a new order.',
      shape:
        'This order has steps the portfolio you reviewed doesn’t call for, so I won’t offer to sign it. Nothing was signed. Make a new order.',
      withdraw:
        'This order takes out other tokens or amounts than the ones you reviewed, so I won’t offer to sign it. Nothing was signed. Make a new withdrawal.',
    },
    shared: {
      publishTitle: 'What you publish',
      followTitle: 'What you follow',
      name: 'Name',
      slug: 'Address on the shelf',
      copy: 'Description',
      noCopy: 'No description.',
      version: 'Version',
      first: 'Version 1, in effect as soon as it lands',
      next: (n: number) => `Version ${n}, in effect after the publish delay`,
      versionN: (n: number) => `Version ${n}`,
      familyId: 'Id',
      onchain: 'On the chain',
      vault: 'Your vault',
      autoFollow: 'Auto-follow',
      on: 'On',
      off: 'Off',
      weights: 'Assets and weights',
      addTitle: 'What you add to',
      addNote:
        'The amount buys these assets at these weights, the targets your vault showed when you chose it. What they leave stays in the vault as cash.',
      addCashNote: 'This vault has no targets, so the whole amount stays in it as cash.',
      publishNote:
        'Your wallet is asked to sign only a transaction that publishes exactly this name, description and these weights, under this id.',
      signPublish: 'Sign and publish',
      signFollow: 'Sign and follow',
      resume: 'Continue',
      withdrawTitle: 'What you withdraw',
      signWithdraw: 'Sign and withdraw',
      /** One line of a withdraw step: what leaves, for the owner's own wallet. */
      withdraws: (amount: string) => `${amount} to your own wallet`,
      withdrawsAll: (held: string) => `All of it, ${held} when reviewed, to your own wallet`,
      withdrawDone: 'What you withdrew is in your wallet now.',
      autoFollowStops: 'Automatic following stops for this vault: the first step switches it off.',
      /** A step whose token could not be moved: it stayed in the vault, and the others went on. */
      skipped: (what: string) =>
        `${what} stayed in the vault: it can’t be moved now. Its issuer may have frozen it, or it needs a wallet that handles its transfer rules.`,
      doneStayed: (chain: string, what: string) =>
        `Done on ${chain}, except ${what}: the vault still holds it. It wasn’t moved, and no step said so.`,
      doneUnread: (chain: string) =>
        `Done on ${chain}. I couldn’t read your vault again, so see your portfolio for anything that stayed.`,
      stayed: (what: string) =>
        `${what} stayed in the vault: the vault’s contract couldn’t move it now. You can try to withdraw it again later.`,
      doneExcept: (chain: string, n: number) =>
        n === 1
          ? `Done on ${chain}, except one step that was skipped: what it would have moved stayed in the vault.`
          : `Done on ${chain}, except ${n} steps that were skipped: what they would have moved stayed in the vault.`,
    },
    signAndBuy: (amount: string) => `Sign and buy ${amount}`,
    resume: (amount: string) => `Continue the buy of ${amount}`,
    signing: (n: number, total: number) => `Signing step ${n} of ${total}…`,
    stepsTitle: 'Steps',
    step: (n: number) => `Step ${n}`,
    kind: {
      approve: 'Allow the deposit',
      create_vault: 'Open your vault and deposit',
      /** The same step where it also buys (Robinhood Chain): the buys are named, not hidden. */
      create_vault_buy: 'Open your vault, deposit and buy',
      deposit_buy: 'Deposit and buy',
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
    signature: 'signature',
    notRetried: '(not retried)',
    link: {
      tx: 'Tx',
      view: 'View transaction {signature} on {explorer}',
      unavailable: 'link unavailable',
    },
    outcome: {
      done: (chain: string) =>
        `Every step is confirmed on ${chain}. Each step’s transaction is linked beside it.`,
      seePortfolio: 'See your portfolio',
      buyMore: 'Buy more',
      /** After a step failed or was refused once the deposit had landed. */
      depositKept:
        'What you deposited is in your vault, as cash: nothing is lost. A new order would deposit again.',
      /** A buy that stopped with its cash in the vault and swaps left, where it can be finished. */
      stopped: (amount: string) =>
        `Your ${amount} is safe in your vault as cash. The buying step didn’t go through.`,
      /** The fold over the check that failed and the guard's own words, to quote to the team. */
      forSupport: 'Details for support',
      /** Finishing a buy that stopped after its deposit, where the server can (finding 24). */
      finish: 'Finish buying with the cash in your vault',
      finishing: 'Making the order…',
      finishNote:
        'A new order for the steps that were left, at the price now. It deposits nothing: you review and sign it as before.',
      /** The server's refusals of that order, each in this app's words. */
      finishOther: 'Another order already finishes this buy: what’s left to buy is in that order.',
      openThatOrder: 'Open that order',
      finishWorking: 'Another request is working on this order. Try again in a moment.',
      finishNothing: 'Nothing is left to buy in this order: every step it had is done.',
      finishShort:
        'Your vault now holds less cash than the steps left would spend: some was spent or withdrawn since. Nothing was made. Add money to the vault for what you still want to buy.',
      finishNotDeposited:
        'This order’s deposit hasn’t landed yet, so there is no cash in the vault to finish with. Sign its steps in order first.',
      finishLater: 'A step signed before can still land. Look again in a minute, then try again.',
      finishRefused: (why: string) => `I couldn’t make that order. Our server said: ${why}.`,
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
      planGone:
        'The plan this order buys isn’t stored any more: a plan from a link that nobody buys is deleted after a few days. The order stopped, and what was signed is kept. Build the plan again from your goal.',
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
          'The plan kept for this order doesn’t match it (another chain, or another vault), so nothing was signed. Make a new order.',
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
      /** In place of "Sign in" for a person signed in on this browser. */
      openApp: 'Open the app',
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
      sample: 'sample rates, not live',
      estimate: 'estimate',
      sampleUnit: 'sample',
      perMonth: '/ month',
      chips: 'The limits',
      legs: 'How the pieces fit',
      chartTable: 'The chart as a table',
      month: 'Month',
      balance: 'Balance',
      /** The line under a chart that reads out the month under the crosshair. */
      readout: {
        hint: 'Point at the chart, tap it or use the arrow keys to read a month.',
        series: 'What the chart draws',
        putIn: 'put in',
        paidOut: 'paid out',
        base: 'base case',
        range: 'weak to strong case',
        weak: 'weak case',
        strong: 'strong case',
        goal: 'goal',
      },
      exitPlan: 'Exit plan before investing',
      trip: {
        label: 'Example: a trip in 2029',
        alt: 'Mariana’s plan drawn as a joint, its parts stacked into one post, each as tall as its share.',
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
        alt: 'Diego’s plan drawn as a joint, its parts stacked into one post, each as tall as its share.',
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
      drawingAlt:
        'Ten coins, each an asset a plan can hold, from stocks and gold to tokenized treasuries, gathering one by one into one plan, each as large as its share.',
      /** The coins of the closing (gate CLOSING-COINS). */
      coins: {
        line: 'One plan, ten pieces, one vault.',
        sample: 'Sample shares, for illustration.',
        parts: 'The sample plan’s parts',
      },
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
    foot: 'The plans, rates and odds on this page are sample data. None of them is live.',
  },

  /** The partner embed (embed-shell.md): his words, in the partner's face. */
  embed: {
    label: 'Plan by tenonfi',
    eyebrow: 'Your goal, read by tenonfi',
    title: 'What does your money need to do?',
    lead: 'Say it in a sentence. I read it into limits; the plan is built in tenonfi, on a wallet of your own.',
    box: 'Your goal',
    placeholder: '$10,000 for five years, medium risk',
    read: 'Read my goal',
    reading: 'Reading your goal…',
    unread: 'Your goal, as read',
    limits: 'How I read it',
    notFound: 'not found: you set it in tenonfi',
    build: 'Build this plan in tenonfi',
    buildNote:
      'Opens tenonfi in a new tab, where you sign in with a wallet of your own. Nothing is signed here.',
    readFailure: 'I couldn’t read that just now. Your text is still here. Try again.',
    tooShort: 'That’s too short for me to read. Try an amount and a time frame.',
    poweredBy: 'Powered by',
    loading: 'Loading plan…',
    unavailable: 'This plan isn’t available.',
    showSchedule: 'Show schedule',
    vault: {
      title: (chain: string) => `Your vault on ${chain}`,
      lead: 'What it holds now, read from the chain.',
      value: 'Value',
      parts: 'Its parts',
      see: 'See it in tenonfi',
    },
  },
};

export type Dictionary = typeof en;
