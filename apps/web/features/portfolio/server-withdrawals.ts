import { PersonWithdrawal } from '@colosseum/schemas';

// The person's withdrawals as the server keeps them (`GET /v1/me/withdrawals`): each with its vault and
// the steps that took tokens out, valued as they were ordered. The portfolio reads them so what was
// taken out of a vault, and the lines of its activity, are the same on a device that never placed them.

/** One withdrawal of the list, as the API's own schema reads it. */
export type ServerWithdrawal = PersonWithdrawal;

/** The most pages of the list one portfolio reads: 200 withdrawals. */
export const MAX_PAGES = 4;

/**
 * The list, or none: a server that has no such route, a call that fails, or an answer that is not the
 * list all read as no withdrawals. One that does not read is left out; the others stay. Page after
 * page while the server names a next one, to a bound: what was read stays if one fails.
 */
export async function readPersonWithdrawals(
  apiFetch: (path: string) => Promise<Response>,
): Promise<ServerWithdrawal[]> {
  const withdrawals: ServerWithdrawal[] = [];
  let before: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    try {
      const res = await apiFetch(
        before ? `/v1/me/withdrawals?before=${encodeURIComponent(before)}` : '/v1/me/withdrawals',
      );
      if (!res.ok) break;
      const body = (await res.json()) as { withdrawals?: unknown; next?: unknown };
      if (!Array.isArray(body.withdrawals)) break;
      for (const w of body.withdrawals) {
        const read = PersonWithdrawal.safeParse(w);
        if (read.success) withdrawals.push(read.data);
      }
      if (typeof body.next !== 'string' || body.next === before) break;
      before = body.next;
    } catch {
      break;
    }
  }
  return withdrawals;
}
