import type { PersonalProposal } from '@colosseum/engine/personal';
import { DISCLAIMER, type Provenance } from '@colosseum/schemas';
import { WORDS } from '../../packages/engine/src/personal/templates';
import type { DataMode } from './data';
import type { GoalRun } from './run';

// The playground's report: one self-contained HTML page per run. Plain on purpose: system fonts, light
// and dark, one column on a phone, no script and nothing fetched. It shows what the engine answered,
// as the API would: the candidates in their fixed order and none marked, every reason sentence, and
// every figure with its provenance; in fixtures mode every figure is plated MOCK. It is a dev tool
// and not advice: the disclaimer is on the page.
//
// The page is a function of the runs, the file name, the mode and the time: no clock is read here, so
// the same file and `--now` give the same page.

export type ReportMeta = {
  file: string;
  mode: DataMode;
  now: string;
};

const esc = (value: unknown): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const usd = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/** A plate for a figure that is not live: MOCK, and for a test network the words "test network". */
export function plate(provenance: Provenance | 'fixture-mode'): string {
  if (provenance === 'live') return '<span class="tag live">live</span>';
  if (provenance === 'sandbox') return '<span class="plate">MOCK · test network</span>';
  return '<span class="plate">MOCK</span>';
}

const list = (items: string[], cls = '') =>
  items.length
    ? `<ul${cls ? ` class="${cls}"` : ''}>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`
    : '<p class="none">none</p>';

const codes = (items: string[]) =>
  items.length
    ? `<p class="codes">${items.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>`
    : '<p class="none">none</p>';

function readSection(run: GoalRun): string {
  const draft = Object.entries(run.intake.draft).filter(([, v]) => v !== null);
  const limits = Object.entries(run.intake.limits).filter(([, v]) => v !== null);
  const r = run.reader;
  const who =
    r.method === 'model'
      ? `the model <code>${esc(r.model)}</code> (${esc(r.provenance)})`
      : `the rules parser${r.why ? ` (no model: <code>${esc(r.why)}</code>)` : ''}`;
  const row = ([k, v]: [string, unknown]) =>
    `<tr><th>${esc(k)}</th><td><code>${esc(JSON.stringify(v))}</code></td></tr>`;
  return `
    <h3>What was read</h3>
    <p>Read by ${who}.</p>
    ${draft.length || limits.length ? `<table class="kv">${[...draft, ...limits].map(row).join('')}</table>` : '<p class="none">nothing read</p>'}
    <h4>Answers from the file</h4>
    ${run.goal.answersText ? `<pre>${esc(run.goal.answersText)}</pre>` : '<p class="none">none</p>'}`;
}

function questionsSection(run: GoalRun): string {
  const i = run.intake;
  const open = run.open.length
    ? `<ol class="questions">${run.open
        .map(
          (q) =>
            `<li><p>${esc(q.text)}</p><p class="meta">Answer under <code>${esc(q.key)}:</code>${
              q.options
                ? ` one of ${q.options.map((o) => `<code>${esc(o)}</code>`).join(', ')}`
                : ''
            }${q.read !== undefined ? `. Read as <code>${esc(JSON.stringify(q.read))}</code>` : ''}</p></li>`,
        )
        .join('')}</ol>
      <p class="meta">Add them to the goal's block:</p>
      <pre>\`\`\`yaml answers
${run.open.map((q) => `${esc(q.key)}: `).join('\n')}
\`\`\`</pre>`
    : '<p class="none">none: the sheet is whole</p>';
  const dis = i.disagreements.length
    ? `<h4>Where the model and the rules parser differ</h4>${list(
        i.disagreements.map(
          (d) =>
            `<code>${esc(d.field)}</code>: model <code>${esc(JSON.stringify(d.model))}</code>, rules <code>${esc(JSON.stringify(d.rules))}</code>`,
        ),
      )}`
    : '';
  return `
    <h3>Questions left open</h3>${open}
    <h4>Intake flags</h4>${codes(i.flags)}${dis}`;
}

function readBackSection(run: GoalRun): string {
  if (!run.intake.readBack) return '';
  return `<h3>Read-back</h3>${list(run.intake.readBack.map(esc), 'readback')}`;
}

function linesTable(plan: PersonalProposal, symbols: Record<string, string>): string {
  const rows = [...plan.lines]
    .map(
      (
        l,
      ) => `<tr><td><strong>${esc(symbols[l.assetId] ?? l.assetId)}</strong><br><span class="meta">${esc(l.assetId)}</span></td>
        <td class="n">${pct(l.weightBps)}</td><td class="n">${usd(l.amountUsd)}</td></tr>
        <tr class="why"><td colspan="3">${list(l.reasons.map((x) => esc(x.text)))}</td></tr>`,
    )
    .join('');
  return `<table class="lines"><thead><tr><th>Token</th><th class="n">Weight</th><th class="n">Dollars</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function scorecard(plan: PersonalProposal): string {
  const s = plan.scorecard;
  if (!s) return '<p class="none">no scorecard</p>';
  const rows: [string, string][] = [
    [
      'Months covered by cash and matching legs',
      s.monthsCovered === null ? 'no withdrawals' : num(s.monthsCovered),
    ],
    [
      'Months paid at the rates observed',
      s.base ? `${s.base.monthsPaid} of ${s.base.monthsWithWithdrawal}` : 'no withdrawals',
    ],
    ...s.stresses.map((x): [string, string] => [`Months paid, stress ${x.id}`, num(x.monthsPaid)]),
    ['Carry observed', `${num(s.carryObservedBps)} bps`],
    [
      'Exit cost at this size',
      s.exit.costBps === null ? 'not measured' : `${num(s.exit.costBps)} bps`,
    ],
    ['Share with a measured exit', pct(s.exit.measuredShareBps)],
    ['Largest issuer', pct(s.concentration.largestIssuerBps)],
    ['Issuers', num(s.concentration.issuers)],
    ['Credit and basis legs', pct(s.creditBasisBps)],
    ...(s.openFxUsd !== undefined ? [['Open FX', usd(s.openFxUsd)] as [string, string]] : []),
  ];
  return `<table class="kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td class="n">${esc(v)}</td></tr>`).join('')}</table>`;
}

function status(plan: PersonalProposal): string {
  const st = plan.status;
  if (!st) return '<p class="none">no withdrawals to come: no status</p>';
  const stresses = st.stresses.map(
    (x) =>
      `<code>${esc(x.id)}</code> ${esc(JSON.stringify(x.params))}: ${x.monthsPaid} of ${x.monthsWithWithdrawal} months paid${x.shortfall ? `, short ${num(x.shortfall)}` : ''}`,
  );
  return `<p><strong>${st.met ? 'Met' : 'Not met'}</strong>: ${st.base.monthsPaid} of ${st.base.monthsWithWithdrawal} months paid at the rates observed${st.observedOn ? ` on ${esc(st.observedOn)}` : ''}${st.base.shortfall ? `, short ${num(st.base.shortfall)}` : ''}.</p>
    <p>Carry needed ${st.carryNeededBps === null ? 'none up to 100% pays' : `${num(st.carryNeededBps)} bps`}, carry observed ${num(st.carryObservedBps)} bps.</p>
    <h5>Stresses</h5>${list(stresses)}
    <h5>Ways to close the gap</h5>${list(st.ways.map((w) => esc(w.change)))}
    ${st.noAmountCloses ? `<p>${esc(st.noAmountCloses)}</p>` : ''}`;
}

/** An income goal's verdict, with what the plan pays a month: null for any other goal. */
export type Income = {
  targetUsd: number;
  /**
   * What the plan pays a month at the yields observed, after haircut. Short: the target less the gap,
   * as the engine counts it. Met: from the card's low return, never under the target.
   */
  paysUsd: number;
  met: boolean;
  gapUsd: number;
  ways: string[];
  noAmountCloses: string | null;
};

const MONTHS = 12;
const PERCENT = 100;

export function incomeOf(plan: PersonalProposal): Income | null {
  const v = plan.verdict;
  const target = plan.sheet.incomeTargetUsdMonthly;
  if (!v || target === undefined) return null;
  const fromCard = (plan.sheet.amountUsd * plan.card.expectedReturn.lowPct) / PERCENT / MONTHS;
  return {
    targetUsd: target,
    paysUsd: v.met ? Math.max(target, fromCard) : Math.max(0, target - v.gapUsdMonthly),
    met: v.met,
    gapUsd: v.gapUsdMonthly,
    ways: v.ways.map((w) => w.change),
    noAmountCloses: v.noAmountCloses ?? null,
  };
}

function incomeBlock(plan: PersonalProposal): string {
  const inc = incomeOf(plan);
  if (!inc) return '';
  const rows: [string, string][] = [
    ['Target a month', usd(inc.targetUsd)],
    [
      'Paid a month at observed yields, after haircut',
      `${inc.met ? 'about ' : ''}${usd(inc.paysUsd)}`,
    ],
    ['Verdict', inc.met ? 'met' : 'short'],
    ['Gap a month', usd(inc.gapUsd)],
  ];
  return `<h5>Income</h5><table class="kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td class="n">${esc(v)}</td></tr>`).join('')}</table>
    ${inc.met ? '' : `<h5>Ways to reach the income</h5>${list(inc.ways.map(esc))}`}
    ${inc.noAmountCloses ? `<p>${esc(inc.noAmountCloses)}</p>` : ''}`;
}

/** The income verdict in a few words for the terminal: "short by $397/month, no larger amount closes it". */
export function incomeWords(inc: Income): string {
  if (inc.met) return `met (${usd(inc.targetUsd)}/month)`;
  const gap = `short by ${usd(inc.gapUsd)}/month of ${usd(inc.targetUsd)}`;
  const ways = inc.ways.length ? `, ${inc.ways.length} way(s)` : '';
  return `${gap}${inc.noAmountCloses ? ', no larger amount closes it' : ''}${ways}`;
}

function observations(plan: PersonalProposal, mode: DataMode): string {
  if (!plan.observations.length) return '<p class="none">none</p>';
  return `<table class="obs"><thead><tr><th>Figure</th><th>Source, method, time</th><th></th></tr></thead><tbody>${plan.observations
    .map(
      (o) =>
        `<tr><td><code>${esc(o.kind)}</code> ${esc(o.id)}</td><td>${esc(o.source ?? 'no source')}<br><span class="meta">${esc(o.method)} · ${esc(o.fetchedAt ?? 'no time')}</span></td><td>${plate(mode === 'fixtures' ? 'fixture-mode' : o.provenance)}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

function candidateCard(id: string, plan: PersonalProposal, run: GoalRun, mode: DataMode): string {
  const lang = plan.sheet.language;
  const name = WORDS[lang].candidate[id] ?? id;
  return `<article class="cand">
    <h4>${esc(name)} ${mode === 'fixtures' ? plate('fixture-mode') : ''}</h4>
    ${linesTable(plan, run.symbols)}
    ${plan.removed.length ? `<h5>Left out</h5>${list(plan.removed.map((r) => `<code>${esc(r.ref)}</code>: ${r.reasons.map((x) => esc(x.text)).join(' ')}`))}` : ''}
    ${incomeBlock(plan)}
    <h5>Scorecard</h5>${scorecard(plan)}
    <h5>Status</h5>${status(plan)}
    <h5>Flags</h5>${codes(plan.flags)}
    <details><summary>Figures and provenance</summary>${observations(plan, mode)}</details>
  </article>`;
}

const sameLines = (a: PersonalProposal, b: PersonalProposal) =>
  JSON.stringify(a.lines.map((l) => [l.assetId, l.weightBps])) ===
  JSON.stringify(b.lines.map((l) => [l.assetId, l.weightBps]));

function plansSection(run: GoalRun, mode: DataMode): string {
  if (run.error) return `<h3>No plan</h3><p class="error">${esc(run.error)}</p>`;
  if (!run.made || !run.plain) return '';
  const lang = run.plain.sheet.language;
  const carry = run.made.shown.find((c) => c.id === 'carry');
  const plainNote =
    carry && sameLines(carry.plan, run.plain)
      ? `<p class="meta">The plain plan (<code>compose</code>) holds the same as Carry.</p>${incomeBlock(run.plain)}`
      : `<details${run.plain.verdict ? ' open' : ''}><summary>The plain plan (<code>compose</code>)</summary>${linesTable(run.plain, run.symbols)}${incomeBlock(run.plain)}${run.plain.status ? `<h5>Status</h5>${status(run.plain)}` : ''}<h5>Flags</h5>${codes(run.plain.flags)}</details>`;
  return `
    <h3>Candidates</h3>
    <p class="meta">In the fixed order, none marked. ${run.made.shown.length} shown.</p>
    <div class="grid">${run.made.shown.map((c) => candidateCard(c.id, c.plan, run, mode)).join('')}</div>
    <h4>Not shown</h4>
    ${list(run.made.notShown.map((n) => `<strong>${esc(WORDS[lang].candidate[n.id] ?? n.id)}</strong>: ${esc(n.why)}`))}
    ${plainNote}`;
}

export function goalSlug(title: string, i: number): string {
  const s = title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `g${i + 1}-${s}`;
}

function goalSection(run: GoalRun, i: number, mode: DataMode): string {
  return `<section class="goal" id="${goalSlug(run.goal.title, i)}">
    <h2>${esc(run.goal.title)} <span class="meta">${esc(run.goal.chain)} · line ${run.goal.line}</span></h2>
    <blockquote>${esc(run.goal.text)}</blockquote>
    ${readSection(run)}
    ${questionsSection(run)}
    ${readBackSection(run)}
    ${plansSection(run, mode)}
    <details><summary>Where the figures come from</summary>${list(run.sources.map(esc))}</details>
  </section>`;
}

const CSS = `
:root{--bg:#fbfaf7;--fg:#1c1b19;--muted:#6b675f;--line:#dedad2;--card:#ffffff;--plate-bg:#fff1c2;--plate-fg:#5a4300;--err:#a3271c;--live:#1d6b3a}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--fg:#ece9e2;--muted:#a29d93;--line:#34312c;--card:#1f1d1a;--plate-bg:#4a3a00;--plate-fg:#ffe08a;--err:#ff8a7a;--live:#7fd49b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:16px}
h1{font-size:1.4rem;margin:.5rem 0}h2{font-size:1.2rem;margin:0 0 .5rem}h3{font-size:1.05rem;margin:1.25rem 0 .4rem}h4{font-size:.95rem;margin:1rem 0 .3rem}h5{font-size:.85rem;margin:.8rem 0 .2rem;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
.meta,.none{color:var(--muted);font-size:.85rem}.none{font-style:italic}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em}
pre{background:var(--card);border:1px solid var(--line);padding:8px;overflow-x:auto}
blockquote{margin:.5rem 0;padding:.5rem .75rem;border-left:3px solid var(--line);white-space:pre-wrap;background:var(--card)}
section.goal{border-top:2px solid var(--line);padding:1rem 0 1.5rem}
table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:4px 6px;border-bottom:1px solid var(--line)}
table.kv th{font-weight:500;width:55%}.n{text-align:right;white-space:nowrap}
tr.why td{border-bottom:1px solid var(--line);padding-top:0}tr.why ul{margin:0;padding-left:1.1rem;font-size:.85rem;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:12px}
.cand{background:var(--card);border:1px solid var(--line);padding:10px;min-width:0}
.plate{display:inline-block;background:var(--plate-bg);color:var(--plate-fg);font-weight:700;font-size:.72rem;padding:1px 6px;letter-spacing:.04em}
.tag.live{color:var(--live);font-size:.75rem}
.banner{background:var(--plate-bg);color:var(--plate-fg);padding:8px 12px;margin:8px 0}
.disclaimer{border:1px solid var(--line);padding:8px 12px;font-size:.85rem;color:var(--muted)}
.error{color:var(--err)}.codes code{display:inline-block;margin:0 4px 4px 0}
details{margin:.5rem 0}summary{cursor:pointer;color:var(--muted)}
nav ol{padding-left:1.2rem}
`;

/** The page for one run. The same runs and meta give the same page. */
export function renderReport(runs: GoalRun[], meta: ReportMeta): string {
  const banner =
    meta.mode === 'fixtures'
      ? `<p class="banner"><span class="plate">MOCK</span> Every figure on this page comes from the engine's fixtures: the launch shelf, yields and exit capacities written by hand for tests. None is live.</p>`
      : `<p class="banner">Figures from the local database, read the way the API reads them. Each keeps its own provenance; anything not live is plated <span class="plate">MOCK</span>, and a test network says so. The shelf is the mock chain's.</p>`;
  const disclaimer = `<div class="disclaimer"><p>${esc(DISCLAIMER.en)}</p><p lang="pt">${esc(DISCLAIMER.pt)}</p></div>`;
  const nav = `<nav><ol>${runs
    .map(
      (r, i) =>
        `<li><a href="#${goalSlug(r.goal.title, i)}">${esc(r.goal.title)}</a> <span class="meta">${
          r.made
            ? `${r.made.shown.length} shown`
            : r.error
              ? 'no plan'
              : `${r.open.length} question(s) open`
        }</span></li>`,
    )
    .join('')}</ol></nav>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Plan playground</title><style>${CSS}</style></head>
<body><main>
<h1>Plan playground</h1>
<p class="meta">${esc(meta.file)} · data: ${esc(meta.mode)} · plans made at ${esc(meta.now)} · a developer tool</p>
${banner}
${disclaimer}
${nav}
${runs.map((r, i) => goalSection(r, i, meta.mode)).join('\n')}
${disclaimer}
</main></body></html>
`;
}

/** A few lines for the terminal. */
export function summary(runs: GoalRun[]): string[] {
  return runs.map((r) => {
    const reader = r.reader.method === 'model' ? `model ${r.reader.model}` : 'rules';
    if (r.error) return `- ${r.goal.title} [${reader}]: no plan: ${r.error}`;
    if (!r.made)
      return `- ${r.goal.title} [${reader}]: ${r.open.length} question(s) open: ${r.open.map((q) => q.key).join(', ')}`;
    const shown = r.made.shown.map((c) => c.id).join(', ');
    const hidden = r.made.notShown.map((c) => c.id).join(', ');
    const plain = r.plain ? incomeOf(r.plain) : null;
    const each = r.made.shown.flatMap((c) => {
      const inc = incomeOf(c.plan);
      return inc ? [`${c.id} ${inc.met ? 'met' : `short ${usd(inc.gapUsd)}`}`] : [];
    });
    const income = plain
      ? `; income ${incomeWords(plain)}${each.length ? ` (${each.join(', ')})` : ''}`
      : '';
    return `- ${r.goal.title} [${reader}]: shown ${shown}${hidden ? `; not shown ${hidden}` : ''}${income}`;
  });
}
