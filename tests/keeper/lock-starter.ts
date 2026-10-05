import { lockState } from '../../apps/keeper/src/memory';

// One keeper starting many times, for the race in memory.test.ts: for each trial it waits for the
// trial's start time, asks for that trial's state file, holds it until the trial's end and releases it.
// It prints one line per trial: `<trial> took`, `<trial> refused <why>` or `<trial> late`.

const [dir, startAt, slotMs, trials] = process.argv.slice(2).map((a, i) => (i ? Number(a) : a)) as [
  string,
  number,
  number,
  number,
];
for (let t = 0; t < trials; t++) {
  const start = startAt + t * slotMs;
  while (Date.now() < start) {
    // Spin, so every starter asks at the same moment.
  }
  // A starter that woke late would ask after the holder let go, which is no race: it sits this one out.
  if (Date.now() > start + slotMs / 4) {
    console.log(`${t} late`);
    continue;
  }
  try {
    const release = lockState(`${dir}/t${t}/state.json`);
    console.log(`${t} took`);
    while (Date.now() < start + slotMs * 0.75) {
      // Held for most of the slot.
    }
    release();
  } catch (e) {
    console.log(`${t} refused ${e instanceof Error ? e.message : String(e)}`);
  }
}
