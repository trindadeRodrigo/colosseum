import { exposure } from './en/exposure';
import { methodology } from './en/methodology';
import { overview } from './en/overview';
import { plan } from './en/plan';
import { rebalancing } from './en/rebalancing';
import { shell } from './en/shell';
import { status } from './en/status';

// The portfolio section (/portfolio/*) in English: a dictionary of its own, as Bearing's is, so the
// routes that do not show the section do not ship its sentences. One file a page under en/, gathered
// here; pt.ts holds the same keys in Brazilian Portuguese. The voice is the product's (i18n/en.ts).
// The sources and methods in a pin's popover are the API's, in English, in both languages.

export const portfolioEn = {
  shell,
  status,
  overview,
  methodology,
  plan,
  rebalancing,
  exposure,
};

export type PortfolioDictionary = typeof portfolioEn;
