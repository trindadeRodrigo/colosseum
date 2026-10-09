import { DISCLAIMER } from '@colosseum/schemas';
import { describe, expect, it } from 'vitest';
import { bearingDictionary } from './bearing';
import {
  DEFAULT_LANG,
  dictionary,
  fill,
  isLang,
  LANGS,
  LOCALE,
  pickLang,
  THEME_CLASS,
  themeChoice,
} from './index';
import { portfolioDictionary } from './portfolio';

// Every sentence a person reads on the product screens, in both languages. The type holds the two
// dictionaries to the same keys; these hold the sentences to the voice (voice-and-tone.md).

type Leaf = { path: string; text: string };

/** Every sentence of a dictionary. A sentence with a value in it is called with stand-ins. */
function sentences(node: unknown, path = ''): Leaf[] {
  if (typeof node === 'string') return [{ path, text: node }];
  if (typeof node === 'function') {
    const stand = Array.from({ length: node.length }, (_, i) => (i === 0 ? 3 : 'Solana'));
    const made = [(node as (...args: unknown[]) => string)(...stand)];
    // a count is said in the singular too
    if (node.length > 0) made.push((node as (...args: unknown[]) => string)(1, 'Solana'));
    return made.map((text) => ({ path, text }));
  }
  if (Array.isArray(node)) return node.flatMap((item, i) => sentences(item, `${path}[${i}]`));
  if (typeof node === 'object' && node !== null)
    return Object.entries(node).flatMap(([key, value]) =>
      sentences(value, path ? `${path}.${key}` : key),
    );
  return [];
}

/**
 * A language's whole dictionary: the product's, and Bearing's and the portfolio section's, which each
 * ship on their own pages only. The section's is held to every rule of the product's: nothing of
 * Bearing's allowance for names in capitals or for fragments applies to it.
 */
const everything = (lang: (typeof LANGS)[number]) => ({
  ...dictionary(lang),
  bearing: bearingDictionary(lang),
  portfolioSection: portfolioDictionary(lang),
});

const paths = (node: unknown) => [...new Set(sentences(node).map((leaf) => leaf.path))].sort();

/** voice-and-tone.md, "Banned words and phrases", and the two words the design bans from templates. */
const BANNED: Record<string, RegExp> = {
  en: /earn up to|guarantee|risk-free|safe yield|beat the bank|passive income|set and forget|autopilot|walk away|self-driving|\bsmart\b|ai-powered|intelligent|\bmagic|unlock|supercharge|seamless|effortless|revolutionary|best-in-class|bespoke|to the moon|degen|don’t miss out|limited time|recommend|suitable|best for you|oops|sorry/i,
  // "Unlock" is banned as a word of promise. A wallet that is locked is unlocked, and that one use
  // is the plain one: "desbloqueie a carteira".
  pt: /garantid|sem risco|renda passiva|piloto automático|inteligente|mágic|desbloque(?!ie a carteira)|revolucion|recomend|adequad|ideal para você|ops\b|desculp/i,
};

/**
 * The names Bearing's analytics write in capitals: tokens and units, zones, venues, the exchange's
 * calendar and the API it reads. Nothing else on those pages is.
 */
const BEARING_NAMES = new Set(
  'API USD USDC USDT USDY SOL TVL LP UTC US EUA KYC DEX CLMM DLMM CPMM NYSE'.split(' '),
);
/**
 * Bearing's labels that are not sentences: a chart's note under its title, an accessible name, the
 * "how" of a path, a tooltip, and the start of the verdict that the page completes. Rodrigo's
 * fragments, kept as he wrote them. Each is named: a new one has to be added here on purpose.
 */
const BEARING_FRAGMENTS = new Set([
  'bearing.chain.sideBySide.caption',
  'bearing.dex.capacity.aria',
  'bearing.dex.capacity.note',
  'bearing.dex.liquidity.aria',
  'bearing.dex.liquidity.note',
  'bearing.flow.aria',
  'bearing.flow.tips.issuerPays',
  'bearing.flow.tips.legCost',
  'bearing.flow.tips.sol',
  'bearing.heat.aria',
  'bearing.lending.avail.jupiter',
  'bearing.lending.avail.note',
  'bearing.lending.covered.aria',
  'bearing.lending.supplied.note',
  'bearing.lending.table.jupiterAvailable',
  'bearing.lending.toleranceTitle',
  'bearing.sim.paths.open.how',
  'bearing.sim.paths.split.how',
  'bearing.sim.verdict.best',
  'bearing.stable.supplied.note',
]);

describe.each(LANGS)('the dictionary in %s', (lang) => {
  const all = sentences(everything(lang));

  it('has every sentence the English one has, and no other', () => {
    expect(paths(everything(lang))).toEqual(paths(everything('en')));
    expect(all.length).toBeGreaterThan(150);
    for (const { path, text } of all) expect(text.trim(), path).not.toBe('');
  });

  it('has no exclamation mark and no emoji', () => {
    for (const { path, text } of all) {
      expect(text, path).not.toMatch(/!/);
      expect(text, path).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('writes no word in capitals but MOCK', () => {
    for (const { path, text } of all) {
      // "US$" is how Portuguese writes a dollar amount, and a sentence may start with one capital.
      // Bearing's pages name tokens, units, zones and venues as they are written (Rodrigo's words).
      const named = path.startsWith('bearing.') ? BEARING_NAMES : new Set<string>();
      const shouting = (text.replace(/US\$/g, '').match(/\p{Lu}{2,}/gu) ?? []).filter(
        (word) => word !== 'MOCK' && !named.has(word),
      );
      expect(shouting, `${path}: ${text}`).toEqual([]);
    }
  });

  it('promises no return, gives no advice and uses none of the banned words', () => {
    for (const { path, text } of all) expect(text, path).not.toMatch(BANNED[lang] as RegExp);
  });

  it('never says the disclaimer in its own words: that text is the one constant', () => {
    for (const { path, text } of all) {
      expect(text, path).not.toMatch(/investment advice|consultoria/i);
      expect(text, path).not.toBe(DISCLAIMER[lang]);
    }
  });

  it('ends every full sentence with a full stop or a question mark', () => {
    // A sentence: more than a dozen words, or more than one of them. A title, a label, the words
    // that follow the MOCK plate and a goal as a person would type it are not sentences.
    const full = all.filter(
      ({ path, text }) =>
        (text.split(' ').length > 12 || /\. \p{L}/u.test(text)) &&
        !/[·…]/.test(text) &&
        !text.startsWith(':') &&
        !BEARING_FRAGMENTS.has(path) &&
        !/^goal\.(examples|composer\.placeholder)/.test(path),
    );
    expect(full.length).toBeGreaterThan(50);
    for (const { path, text } of full) expect(text, path).toMatch(/[.?]$/);
  });
});

describe('the words of the product, in each language', () => {
  const en = dictionary('en');
  const pt = everything('pt');

  it('says goal, limits and plan in English, and objetivo, limites and plano in Portuguese', () => {
    expect(en.goal.sheet.build).toBe('Build my plan');
    expect(en.goal.card.edit).toBe('Edit limits');
    expect(pt.goal.sheet.build).toBe('Montar meu plano');
    expect(pt.goal.card.edit).toBe('Editar limites');
    expect(pt.goal.composer.label).toBe('Seu objetivo');
  });

  it('says "Sign in" on the button (gate SIGN-IN-LABEL)', () => {
    expect(en.shell.signIn).toBe('Sign in');
    expect(pt.shell.signIn).toBe('Entrar');
  });

  it('writes Portuguese as a Brazilian reads it: "você", never "tu" or the European forms', () => {
    const text = sentences(pt)
      .map((leaf) => leaf.text)
      .join(' ');
    // \b does not know an accented letter, so the edges of a word are said outright
    const word = (list: string) => new RegExp(`(?<!\\p{L})(${list})(?!\\p{L})`, 'iu');
    expect(text).toMatch(word('você'));
    expect(text).not.toMatch(word('tu|teu|tua|vós|connosco|ecrã|utilizador|telemóvel|registo'));
    // the wallet is "carteira", so the portfolio is never called that
    expect(text).not.toMatch(/carteira de investimentos/i);
  });

  it('uses the words that were decided, in Portuguese', () => {
    const all = sentences(pt);
    const text = all.map((leaf) => leaf.text).join(' ');
    const word = (list: string) => new RegExp(`(?<!\\p{L})(${list})(?!\\p{L})`, 'iu');
    // the noun for signing in is "login", and a session expires
    expect(text).not.toMatch(word('entrada|entradas'));
    expect(pt.signIn.off.api).toMatch(/^O login está indisponível/);
    expect(pt.chain.failure.signedOut).toMatch(/^Sua sessão expirou/);
    // switched on is "ativada", not there for now is "indisponível", linked is "vinculada"
    expect(text).not.toMatch(word('ligad[oa]s?|desligad[oa]s?'));
    expect(pt.signIn.failure.passkeyOff).toContain('ativadas');
    expect(pt.chain.noWallet).toContain('vinculada');
    // one word for dollar yield, which is not income
    expect(text).not.toMatch(/renda em dólar/i);
    expect(pt.goal.fields.glide).toContain('rendimento em dólar');
    expect(pt.goal.captions.protect).toContain('rendimento em dólar');
    // and the rest of the list
    expect(pt.signIn.failure.passkeyUnknown).toMatch(/^Não reconheço essa chave de acesso/);
    expect(pt.signIn.failure.walletSilent).toContain('desbloqueie a carteira');
    expect(pt.goal.sheet.summaryOne).toContain('não se encaixa');
    expect(pt.goal.sheet.summaryOther).toContain('não se encaixam');
    expect(pt.shell.disclaimer).toBe('Aviso legal');
  });

  it('says a passkey that is not registered here in so many words, in both languages', () => {
    const [en, pt] = [dictionary('en'), dictionary('pt')];
    expect(en.signIn.failure.passkeyNotRegistered).toMatch(/^That passkey isn’t registered here: /);
    expect(pt.signIn.failure.passkeyNotRegistered).toMatch(
      /^Essa chave de acesso não está registrada aqui: /,
    );
    // and it does not send the person to make a new one, which would open a second, empty account
    for (const d of [en, pt])
      expect(d.signIn.failure.passkeyNotRegistered).not.toMatch(/create|crie|criar/i);
  });

  it('still bans "unlock" as a word of promise, in Portuguese too', () => {
    expect('Desbloqueie rendimentos maiores').toMatch(BANNED.pt as RegExp);
    expect('desbloquear seu potencial').toMatch(BANNED.pt as RegExp);
    expect(pt.signIn.failure.walletSilent).not.toMatch(BANNED.pt as RegExp);
    expect(en.signIn.failure.walletSilent).not.toMatch(BANNED.en as RegExp);
  });

  it('asks for what the limits hold: an amount to start with, a time frame, a risk', () => {
    for (const d of [en, pt]) {
      // the sheet has no field for how soon the cash is needed, so nothing asks for it
      const asked = [d.goal.lead, d.goal.composer.placeholder, ...d.goal.examples.list].join(' ');
      expect(asked).not.toMatch(/cash within|how soon|resgate|7 d/i);
      expect(d.goal.examples.list).toHaveLength(3);
    }
    expect(en.goal.examples.list).toEqual([
      'Grow $2,000 for ten years, high risk',
      'Protect $50,000 for 18 months, low risk',
      '$80,000 for $300 a month of income, 5 years, low risk',
    ]);
  });

  it('calls a part of a plan a part, and says nothing was deposited', () => {
    expect(en.goal.built.done.body(3, 'Solana')).toBe(
      'It has 3 parts on Solana. Nothing was deposited.',
    );
    expect(en.goal.built.done.body(1, 'Solana')).toContain('1 part on');
    expect(pt.goal.built.done.body(3, 'Solana')).toContain('3 partes');
    for (const d of [en, pt])
      expect(d.goal.built.done.body(2, 'Solana')).not.toMatch(
        /\blines?\b|linhas?|comes next|vem a seguir/,
      );
  });

  it('says an empty field is missing, and a wrong one does not fit', () => {
    expect(en.goal.sheet.missingOther).toBe(
      '{n} things are still missing. Fill them in to build the plan.',
    );
    expect(en.goal.sheet.summaryOther).toBe(
      '{n} things don’t fit yet. Fix them to build the plan.',
    );
    expect(pt.goal.sheet.missingOne).toMatch(/^Ainda falta 1 coisa/);
  });

  it('keeps MOCK and the names of the chains as they are in both', () => {
    expect(pt.chain.names).toEqual(en.chain.names);
    expect(pt.shell.testNetwork).toBe('rede de teste');
    expect(en.shell.testNetwork).toBe('test network');
  });

  it('points nobody at the bar for a chain, in both (CHAIN-AT-THE-PLAN)', () => {
    // the bar shows and switches none: where a plan starts is chosen on /goal
    for (const d of [en, pt])
      expect(JSON.stringify(d)).not.toMatch(
        /from the bar|bar at the top|pela barra|na barra no topo/i,
      );
    for (const d of [en, pt]) expect(d.chain.is.picked('Solana')).not.toMatch(/\bbar\b|barra/i);
    // said when the account could not be read: it points at no place that has no choice either
    expect(en.goal.blocked.chainNotChosen).not.toMatch(/Invest|bar/);
    expect(pt.goal.blocked.chainNotChosen).not.toMatch(/Investir|barra/);
    // nothing says the chain can't be changed any more
    for (const d of [en, pt])
      expect(JSON.stringify(d.chain)).not.toMatch(/can’t be changed|não pode ser mudad|once\b/);
  });
});

describe('which language a request gets', () => {
  it('is the person’s own choice when they made one', () => {
    expect(pickLang('pt', 'en-US,en;q=0.9')).toBe('pt');
    expect(pickLang('en', 'pt-BR')).toBe('en');
  });

  it('is otherwise the first of ours the browser asks for', () => {
    expect(pickLang(undefined, 'pt-BR,pt;q=0.9,en;q=0.8')).toBe('pt');
    expect(pickLang(undefined, 'fr-FR,fr;q=0.9,en;q=0.8,pt;q=0.7')).toBe('en');
    expect(pickLang(undefined, 'en;q=0.5, pt;q=0.9')).toBe('pt');
    expect(pickLang(undefined, 'es, pt;q=0')).toBe(DEFAULT_LANG);
  });

  it('is English for anything else, and for a cookie that names no language of ours', () => {
    expect(pickLang(undefined, null)).toBe('en');
    expect(pickLang(undefined, 'de-DE,de;q=0.9')).toBe('en');
    expect(pickLang('<script>', 'pt')).toBe('pt');
    expect(isLang('pt')).toBe(true);
    expect(isLang('es')).toBe(false);
    expect(LOCALE).toEqual({ en: 'en', pt: 'pt-BR' });
  });
});

describe('light, dark, or the system’s', () => {
  it('follows the system unless the person chose', () => {
    expect(themeChoice(undefined)).toBe('auto');
    expect(themeChoice('dark')).toBe('dark');
    expect(themeChoice('light')).toBe('light');
    expect(themeChoice('sepia')).toBe('auto');
    expect(THEME_CLASS).toEqual({ auto: 'tf-auto', light: 'light', dark: 'dark' });
  });
});

describe('fill', () => {
  it('puts a value where a template names it, and leaves what it does not know', () => {
    expect(fill('{n} things don’t fit yet.', { n: 2 })).toBe('2 things don’t fit yet.');
    expect(fill('{n} of {total}', { n: 1 })).toBe('1 of {total}');
  });
});
