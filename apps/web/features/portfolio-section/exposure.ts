import type { PortfolioDictionary } from '../../i18n/portfolio';
import type { ExposureChain } from './api';

// What the exposure page asks of an answer of GET /v1/portfolio/exposure before it draws it: whether
// a chain holds anything, the order its shares are listed in, and the sentence of each flag of the
// risk roll-up. Nothing here is a figure: the sums are the answer's, handed on as they came.

/** A chain with something to show: a sum, or a holding that is in none. */
export const holds = (chain: ExposureChain): boolean =>
  chain.byUnderlying.length > 0 || chain.byIssuer.length > 0 || chain.unvalued.length > 0;

/** Largest first, as every list of shares is read. Where two are equal the answer's order stands. */
export const largestFirst = <T extends { bps: number }>(shares: readonly T[]): T[] =>
  [...shares].sort((a, b) => b.bps - a.bps);

/** A flag of the roll-up as the page says it; `sentence` is null where the page has no words for it. */
export type SaidFlag = { flag: string; sentence: string | null };

/** The one flag that reads the issuers (`ROLL_UP_FLAGS.issuer` of packages/basket). */
const ISSUER_FLAG = 'issuer_concentration';

/**
 * The roll-up's flags in a person's words, each sentence once. A flag that names what is not live
 * after a colon (`measured_provenance:fixture`) is said by the sentence of its first part. One the
 * page has no sentence for is kept, to be shown by its own name: a note is never dropped in silence.
 * On the sample chain every issuer is a stand-in, so one issuer holding more than half is no finding
 * there and is not said.
 */
export function flagsSaid(
  flags: readonly string[],
  say: PortfolioDictionary['exposure']['flags']['say'],
  sample: boolean,
): SaidFlag[] {
  const said: SaidFlag[] = [];
  for (const flag of flags) {
    const code = flag.split(':')[0] ?? flag;
    if (sample && code === ISSUER_FLAG) continue;
    const sentence = Object.hasOwn(say, code) ? say[code as keyof typeof say] : null;
    if (
      sentence === null
        ? said.some((s) => s.flag === flag)
        : said.some((s) => s.sentence === sentence)
    )
      continue;
    said.push({ flag, sentence });
  }
  return said;
}
