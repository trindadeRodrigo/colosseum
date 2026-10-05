import { readFileSync } from 'node:fs';
import { lockState } from '../../apps/keeper/src/memory';

// One keeper starting many times, for the race in memory.test.ts. It says `ready`, reads the start time
// from its input, and for each trial asks for that trial's state file at the trial's start, printing
// `<trial> took` or `<trial> refused <why>`. What it takes it holds until every trial is over, so a
// starter that asks late can only be refused, never let in after a release.

const [dir, slotMs, trials] = process.argv.slice(2).map((a, i) => (i ? Number(a) : a)) as [
  string,
  number,
  number,
];
console.log('ready');
const startAt = Number(readFileSync(0, 'utf8'));

/** Sleeps without spending the CPU the rest of the suite runs on. */
const sleepUntil = (at: number) => {
  const ms = at - Date.now();
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const held: (() => void)[] = [];
for (let t = 0; t < trials; t++) {
  const start = startAt + t * slotMs;
  sleepUntil(start - 20);
  while (Date.now() < start) {
    // Spin the last moment, so every starter asks at the same time.
  }
  try {
    held.push(lockState(`${dir}/t${t}/state.json`));
    console.log(`${t} took`);
  } catch (e) {
    console.log(`${t} refused ${e instanceof Error ? e.message : String(e)}`);
  }
}
sleepUntil(startAt + (trials + 3) * slotMs);
for (const release of held) release();
