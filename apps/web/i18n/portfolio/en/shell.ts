// The frame of the portfolio section (/portfolio/*), in English: the side menu, and the sentences every
// page says when there is nobody to read for, while it reads, and when a read fails. Each page's own
// words are in the file beside this one that carries its name.

export const shell = {
  /** After a page's name in the browser tab: "Overview · Your portfolio". */
  head: 'Your portfolio',
  /** The heading of the disclaimer under every page. */
  notAdvice: 'Not licensed advice',
  menu: {
    region: 'Portfolio pages',
    nav: 'Portfolio',
    show: 'Show menu',
    hide: 'Hide menu',
  },
  reading: 'Reading your plans…',
  signedOut:
    'Sign in to see your plans over time. Each one sits in a vault on the chain of your wallet, and only you can withdraw from it.',
  /** Signed in, with no plan in a vault on any chain that was read. */
  empty: 'You have no plan in a vault yet. A vault is made with your first deposit.',
  startGoal: 'Start with your goal',
  again: 'Read again',
  againBusy: 'Reading…',
  /** Each way a read can fail, in its own sentence. */
  failure: {
    /** The route is not there: a server from before the section. */
    unavailable:
      'This server doesn’t keep a history of your plans yet, so there is nothing to show here. I won’t show made-up figures in its place.',
    signedOut:
      'Our server doesn’t recognise your sign-in any more, so I can’t read your plans. Sign out, then sign in again.',
    noIdentity:
      'I can’t read your plans yet: the sign-in service didn’t give me the part of your sign-in that lists your wallets. Wait a minute, then try again.',
    throwaway:
      'The throwaway wallet has no account on our server, so there are no plans of it to read.',
    unreachable: 'I couldn’t reach our server to read your plans. Try again.',
    unreadable:
      'Our server answered with something I couldn’t read, so I’m not showing it. Try again.',
    /** The server would not take what was asked: an address that is none, a window it does not serve. */
    refused: 'Our server didn’t take that request, so there is nothing to show for it.',
  },
  /** What a page of the section says until it is built. */
  soon: 'This page isn’t built yet, so there is nothing to read here for now.',
};

export type Shell = typeof shell;
