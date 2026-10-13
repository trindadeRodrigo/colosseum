import type { PortfolioDictionary } from './en';
import { exposure } from './pt/exposure';
import { methodology } from './pt/methodology';
import { overview } from './pt/overview';
import { plan } from './pt/plan';
import { rebalancing } from './pt/rebalancing';
import { shell } from './pt/shell';
import { status } from './pt/status';

// The portfolio section in Brazilian Portuguese: the same keys as en.ts, one file a page under pt/.

export const portfolioPt: PortfolioDictionary = {
  shell,
  status,
  overview,
  methodology,
  plan,
  rebalancing,
  exposure,
};
