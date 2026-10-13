import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Gate WORDS-VAULT-DEPOSIT (Thom, Oct 9), on the server's side: the sentences a person can come to
// read say vault and deposit, never "mix" or "buy". Those are the notes the goal agent's code writes,
// an order's summary, step names and warnings, every refusal's sentence and its fix (the web shows a
// refusal it has no words of its own for), and the two conversation prompts, whose vocabulary the
// model's prose follows. They are read from the source: every string of these files that is a
// sentence (it has a space) is held to the rule. What is not a sentence a person reads is listed.

const FORBIDDEN = /\b(mix|mixes|buy|buys|buying|bought|purchase|purchases|purchased)\b/i;
const HERE = import.meta.dirname;
const FILES = [
  ...readdirSync(join(HERE, 'orders'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => `orders/${name}`),
  'faucet/test-funds.ts',
  'vault-agent-model.ts',
  'routes/v1/mix.ts',
];

/** Kept on purpose: a string holding one of these is not a sentence the product says. */
const KEPT: { has: string; why: string }[] = [
  {
    has: 'Never write "mix", "buy", "bought" or "purchase"',
    why: 'the prompts’ own rule, which has to name the words it forbids',
  },
  {
    has: 'add remove drop swap replace put include buy sell',
    why: 'the words the server reads in the person’s own messages (stated-purpose.ts), never shown',
  },
];

type Found = { file: string; text: string };

function strings(file: string): Found[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(HERE, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: Found[] = [];
  const walk = (node: ts.Node) => {
    // a route's OpenAPI summary and description are for a developer reading the API's documents
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      (node.name.text === 'description' || node.name.text === 'summary') &&
      file.startsWith('routes/')
    )
      return;
    if (ts.isImportDeclaration(node) || ts.isRegularExpressionLiteral(node)) return;
    if (ts.isStringLiteralLike(node)) found.push({ file, text: node.text });
    else if (ts.isTemplateExpression(node))
      found.push({
        file,
        text: [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join('…'),
      });
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found.filter(({ text }) => text.includes(' '));
}

const all = FILES.flatMap(strings);
const kept = (text: string) => KEPT.some(({ has }) => text.includes(has));

describe('the server’s sentences: vault and deposit, never mix or buy', () => {
  it('reads the notes, the refusals, the step names and both prompts', () => {
    expect(all.length).toBeGreaterThan(300);
    const texts = all.map(({ text }) => text);
    expect(
      texts.some((text) => text.startsWith('Your deposit goes into exactly these holdings')),
    ).toBe(true);
    expect(texts.some((text) => text.startsWith('You are the planner at Tenonfi'))).toBe(true);
    expect(texts.some((text) => text.startsWith('You are the conversational agent'))).toBe(true);
    expect(texts.some((text) => text.includes('into your plan’s vault on'))).toBe(true);
    expect(texts).toContain('this vault cannot take a deposit as sent');
  });

  it('finds none outside the short list kept on purpose', () => {
    const found = all
      .filter(({ text }) => FORBIDDEN.test(text) && !kept(text))
      .map(({ file, text }) => `${file}: ${text.slice(0, 160)}`);
    expect(found).toEqual([]);
  });

  it('keeps the list honest: every entry still matches a string that holds such a word', () => {
    for (const { has } of KEPT)
      expect(
        all.some(({ text }) => text.includes(has) && FORBIDDEN.test(text)),
        has,
      ).toBe(true);
  });

  it('tells both models the product’s words', () => {
    const rule = all.filter(({ text }) =>
      text.includes('Never write "mix", "buy", "bought" or "purchase"'),
    );
    expect(rule.map(({ file }) => file).sort()).toEqual([
      'orders/relaxed-goal-agent.ts',
      'vault-agent-model.ts',
    ]);
  });
});
