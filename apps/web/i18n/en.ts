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
    signIn: 'Sign in',
    signOut: 'Sign out',
    signingOut: 'Signing out…',
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
    },
    unknown: {
      body: 'I can’t tell yet which chain your plan lives on: our server didn’t answer. Nothing is wrong with your wallet.',
      retry: 'Ask again',
      asking: 'Asking…',
      /** The API answered 401: it does not know this sign-in any more. */
      signedOut:
        'Our server doesn’t recognise your sign-in any more, so I can’t tell which chain your plan lives on. Sign out, then sign in again.',
    },
    noWallet:
      'You’re signed in, but no wallet is linked to this sign-in yet, so there is no chain for your plan.',
    reading: 'Reading where your plan lives…',
  },

  goal: {
    title: 'What does your money need to do?',
    lead: 'Say it in a sentence: how much, by when, and how soon you might need the cash. I read it into limits you can check and change. Nothing is built until you say so.',
    composer: {
      label: 'Your goal',
      placeholder: '$40,000 by June 2028, cash within 7 days',
      hint: 'Enter to read it · Shift+Enter for a new line',
      send: 'Read my goal',
      busy: 'Reading your goal…',
    },
    examples: {
      label: 'Examples',
      list: [
        'Grow $40,000 for an apartment by June 2028',
        '$1,500 a month of income from 2029, cash within 7 days',
        'Protect $25,000 for two years, low risk',
      ],
    },
    readFailure: {
      unreachable:
        'I couldn’t reach our server to read that. Your text is still here. Try again in a moment.',
      tooShort: 'That’s too short for me to read. Try an amount and a date.',
      unreadable: 'I got an answer I couldn’t read. Your text is still here. Try again.',
    },
    /** Under the sheet's title, while the only reader is the one made for goals in reais. */
    readerNote:
      'Today’s reader was made for goals in reais, so it can miss a dollar amount or a date. Check each field: what it didn’t find is left empty for you.',
    sheet: {
      title: 'How I read your goal',
      parser: 'parser',
      summaryOne: '1 thing doesn’t fit yet. Fix it to build the plan.',
      summaryOther: '{n} things don’t fit yet. Fix them to build the plan.',
      goToField: 'Go to field',
      build: 'Build my plan',
      building: 'Building your plan…',
      fixOne: 'Fix the field above to continue.',
      fixOther: 'Fix the {n} fields above to continue.',
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
        body: (lines: number, chain: string) =>
          `It has ${lines === 1 ? '1 line' : `${lines} lines`} on ${chain}. The screen that shows it comes next. Nothing was bought.`,
      },
    },
  },
};

export type Dictionary = typeof en;
