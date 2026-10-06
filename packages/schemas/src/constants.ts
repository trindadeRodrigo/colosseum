/** Single source of the not-licensed-advice disclaimer. Rendered on the plan view, in API docs and responses. */
export const DISCLAIMER = {
  pt: 'Esta ferramenta não presta consultoria de investimentos nem é licenciada para tal. Ela estrutura e explica alocações a partir de um objetivo informado por você; a decisão e a custódia são suas. O distribuidor que embute esta ferramenta detém o relacionamento com o cliente.',
  en: 'This tool is not licensed investment advice. It structures and explains an allocation from a goal you state; the decision and custody are yours. The distributor embedding this tool holds the client relationship.',
} as const;

/**
 * The one-line pointer a compact panel may carry beside the full block (disclaimer-block.md), in the
 * view's language. The Portuguese is a translation of the English line: the spec gives none.
 */
export const DISCLAIMER_SHORT = {
  pt: 'Não é consultoria de investimentos licenciada. Política na sua carteira, não um fundo.',
  en: 'Not licensed investment advice. Policy in your wallet, not a fund.',
} as const;
