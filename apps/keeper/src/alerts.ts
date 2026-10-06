// Where the keeper's alerts go beyond its log (DESIGN-VAULT section 10): a Discord webhook for what a
// person should look at, and a healthchecks.io ping after every round, so a keeper that stopped is
// noticed too. Both are optional, and both URLs come from the environment and are never printed: a
// webhook URL is a key to the channel. A post that fails is said on stderr in words of its own and
// never stops the keeper.

export type Notifier = {
  /** Posts the round's alerts, if any, as one message. */
  alert(lines: string[]): Promise<void>;
  /** Tells the health check the round ran, or that it failed. */
  ping(ok: boolean): Promise<void>;
};

/** Discord takes at most 2,000 characters a message. */
const DISCORD_MAX = 2_000;

export function notifierFromEnv(
  env: Record<string, string | undefined>,
  o: { fetch?: typeof fetch; warn?: (line: string) => void; label?: string } = {},
): Notifier {
  const post = o.fetch ?? fetch;
  const warn = o.warn ?? ((line: string) => console.error(line));
  const webhook = env.KEEPER_DISCORD_WEBHOOK?.trim() || null;
  const health = env.KEEPER_HEALTHCHECK_URL?.trim() || null;
  const label = o.label ?? 'keeper';
  const send = async (what: string, url: string, init: RequestInit) => {
    try {
      const res = await post(url, { ...init, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) warn(`the ${what} answered ${res.status}`);
    } catch {
      warn(`the ${what} could not be reached`);
    }
  };
  return {
    async alert(lines) {
      if (!webhook || lines.length === 0) return;
      let content = `**${label}**: ${lines.length} alert${lines.length === 1 ? '' : 's'}\n${lines
        .map((l) => `- ${l}`)
        .join('\n')}`;
      if (content.length > DISCORD_MAX) content = `${content.slice(0, DISCORD_MAX - 2)}…`;
      await send('alert webhook', webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
    },
    async ping(ok) {
      if (!health) return;
      await send('health check', ok ? health : `${health.replace(/\/$/, '')}/fail`, {
        method: 'POST',
      });
    },
  };
}
