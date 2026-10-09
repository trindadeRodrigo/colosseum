import 'dotenv/config';
import { venuesReport } from './run';

// PLAN-UNIVERSE RU.13 — `pnpm risk:venues [--md] [options]`: the venues we do not read, one table per chain and the
// ranking. It reads files, and one table of the local database (a SELECT); it writes nothing and calls no network.
//
//   --fixtures               everything from the rows frozen under fixtures/: the tables of the frozen window, from
//                            the repository alone (no collector's home, no database). The options below still apply
//   --quotes <file|folder>   Jupiter's stored quotes, .jsonl or .jsonl.gz (default: RISK_HOME/quotes, the collector's)
//   --until <time>           leave out the quotes fetched after it (the collector's files keep growing)
//   --registry <file>        the collector's registry (default: RISK_HOME/registry.json)
//   --known <file>           every pool the registry run found (default: the frozen copy under fixtures/risk/universe)
//   --discovery <file>       DexScreener's pairs (default: the newest pools-dexscreener-*.jsonl of RISK_DATA_DIR)
//   --pools <file>           the chain read of the pools on the routes (default: the newest fixtures/risk/venues/route-pools-*.json)
//   --byreal <file>          the Byreal probe (default: the newest fixtures/risk/venues/byreal-*.json)
//   --captures <folder>      captures of pnpm risk:split-capture --two-hop: adds the gap to Jupiter by venue
//   --robinhood <file>       Robinhood Chain from one frozen file (the cut's pools joined with discovery, and the flow
//                            rows), as pnpm risk:venues-freeze-fixtures writes it
//   --cut <file>             Robinhood Chain's cut (default: the newest cut-robinhood-*.json of RISK_EVM_DIR), read
//                            with the discovery file of the same stamp; the flow rows then come from risk_pool_flow
//   --no-robinhood           the Solana tables only
//   --md                     the tables as Markdown, as they stand in PLAN-UNIVERSE section 6
process.stdout.write(await venuesReport(process.argv.slice(2), process.env));
