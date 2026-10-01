import 'dotenv/config';
import { createInterface } from 'node:readline/promises';

// Executes the demo plan on mainnet from the demo wallet, after an explicit confirmation. Wired in D3-AM.
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(
  'This sends REAL mainnet transactions from the demo wallet. Type "execute" to continue: ',
);
rl.close();
if (answer.trim() !== 'execute') {
  console.log('aborted');
  process.exit(1);
}
console.log(
  'execution engine is implemented in slot D3-AM (docs/structurer/PLAN.md §4); nothing was sent',
);
process.exit(2);
