import { PersonWithdrawal } from '@colosseum/schemas';

// The person's withdrawals as the server keeps them (`GET /v1/me/withdrawals`): each with its vault and
// the steps that took tokens out, valued as they were ordered. The portfolio reads them so what was
// taken out of a vault, and the lines of its activity, are the same on a device that never placed them.

/** One withdrawal of the list, as the API's own schema reads it. */
export type ServerWithdrawal = PersonWithdrawal;

/**
 * The list, or none: a server that has no such route, a call that fails, or an answer that is not the
 * list all read as no withdrawals. One that does not read is left out; the others stay.
 */
export async function readPersonWithdrawals(
  apiFetch: (path: string) => Promise<Response>,
): Promise<ServerWithdrawal[]> {
  try {
    const res = await apiFetch('/v1/me/withdrawals');
    if (!res.ok) return [];
    const body = (await res.json()) as { withdrawals?: unknown };
    if (!Array.isArray(body.withdrawals)) return [];
    return body.withdrawals.flatMap((w) => {
      const read = PersonWithdrawal.safeParse(w);
      return read.success ? [read.data] : [];
    });
  } catch {
    return [];
  }
}
