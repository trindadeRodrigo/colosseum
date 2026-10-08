import { AssetId, Provenance, type VaultResponse } from '@colosseum/schemas';
import type { ApiFetch } from '../account/person';
import { sameAddress } from '../portfolio/vault-name';
import type { Turn } from './storage';

export type VaultStrategyPreview = {
  objective: string;
  summary: string;
  allocations: {
    assetId: string;
    weightBps: number;
    why: string;
    evidenceIds: string[];
    symbol?: string;
  }[];
  tradeoffs: string[];
  unknowns: string[];
  sources: {
    id: string;
    source: string;
    fetchedAt: string;
    method: string;
    provenance: Provenance;
    label?: string;
    value?: number | null;
    unit?: string;
  }[];
};
/** Independent from the new-goal wizard; the provider owns grounded dialogue and policy checks. */
export type VaultAgentRequest = {
  vault: VaultResponse;
  transcript: readonly Turn[];
  language: 'en' | 'pt';
  signal?: AbortSignal;
};
export type VaultAgentReply = {
  message: string;
  question?: string;
  proposal?: VaultStrategyPreview;
};
export type VaultAgent = (request: VaultAgentRequest) => Promise<unknown>;
export class VaultAgentError extends Error {
  constructor(readonly kind: 'unavailable' | 'failed') {
    super(kind);
  }
}
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const texts = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) && value.length <= 20 && value.every((v) => text(v, max));

/** A provider reply is plain data. A preview grants no signing or funded-vault update capability. */
export function agentReplyOf(value: unknown, vault: VaultResponse): VaultAgentReply | null {
  const row = record(value);
  if (
    row?.version !== 1 ||
    row.chain !== vault.chain ||
    typeof row.address !== 'string' ||
    !sameAddress(vault.chain, row.address, vault.vault.address) ||
    !text(row.messageId, 64) ||
    !text(row.message, 2400) ||
    (row.question != null && !text(row.question, 500))
  )
    return null;
  let proposal: VaultStrategyPreview | undefined;
  if (row.proposal != null) {
    const p = record(row.proposal);
    if (
      !p ||
      !text(p.objective, 800) ||
      !text(p.summary, 1600) ||
      !texts(p.tradeoffs, 600) ||
      !texts(p.unknowns, 600) ||
      !Array.isArray(p.sources) ||
      p.sources.length > 1024 ||
      !Array.isArray(p.allocations) ||
      !p.allocations.length ||
      p.allocations.length > 64
    )
      return null;
    const sources: VaultStrategyPreview['sources'] = [];
    for (const raw of p.sources) {
      const s = record(raw);
      const provenance = Provenance.safeParse(s?.provenance);
      if (
        !s ||
        !text(s.id, 160) ||
        !text(s.source, 2000) ||
        !text(s.method, 2000) ||
        !text(s.fetchedAt, 100) ||
        !Number.isFinite(Date.parse(s.fetchedAt)) ||
        !provenance.success ||
        sources.some((old) => old.id === s.id)
      )
        return null;
      if (
        (s.label !== undefined && !text(s.label, 200)) ||
        (s.unit !== undefined && !text(s.unit, 80)) ||
        (s.value !== undefined &&
          s.value !== null &&
          (typeof s.value !== 'number' || !Number.isFinite(s.value)))
      )
        return null;
      sources.push({
        id: s.id,
        source: s.source,
        method: s.method,
        fetchedAt: s.fetchedAt,
        provenance: provenance.data,
        ...(s.label !== undefined ? { label: s.label as string } : {}),
        ...(s.unit !== undefined ? { unit: s.unit as string } : {}),
        ...(s.value !== undefined ? { value: s.value as number | null } : {}),
      });
    }
    const allocations: VaultStrategyPreview['allocations'] = [];
    for (const raw of p.allocations) {
      const a = record(raw);
      const asset = AssetId.safeParse(a?.assetId);
      if (
        !a ||
        !asset.success ||
        !asset.data.startsWith(`${vault.chain}:`) ||
        !Number.isInteger(a.weightBps) ||
        (a.weightBps as number) <= 0 ||
        (a.weightBps as number) > 10_000 ||
        !text(a.why, 1000) ||
        !texts(a.evidenceIds, 160) ||
        a.evidenceIds.length < 1 ||
        a.evidenceIds.length > 16 ||
        (a.symbol !== undefined && !text(a.symbol, 80)) ||
        !a.evidenceIds.every((id) => sources.some((s) => s.id === id)) ||
        allocations.some((old) => old.assetId === asset.data)
      )
        return null;
      allocations.push({
        assetId: asset.data,
        weightBps: a.weightBps as number,
        why: a.why,
        evidenceIds: a.evidenceIds,
        ...(a.symbol ? { symbol: a.symbol as string } : {}),
      });
    }
    if (allocations.reduce((sum, a) => sum + a.weightBps, 0) !== 10_000) return null;
    proposal = {
      objective: p.objective,
      summary: p.summary,
      allocations,
      tradeoffs: p.tradeoffs,
      unknowns: p.unknowns,
      sources,
    };
  }
  return {
    message: row.message,
    ...(row.question ? { question: row.question as string } : {}),
    ...(proposal ? { proposal } : {}),
  };
}

export function vaultAgent(
  api: ApiFetch,
  chain: VaultResponse['chain'],
  address: string,
): VaultAgent {
  return async (request) => {
    const response = await api(
      `/v1/vaults/${encodeURIComponent(chain)}/${encodeURIComponent(address)}/conversation/reply`,
      {
        method: 'POST',
        signal: request.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          language: request.language,
          messages: request.transcript.map(({ who, text }) => ({ who, text })),
          messageId: request.transcript.at(-1)?.id,
        }),
      },
    );
    if (!response.ok)
      throw new VaultAgentError(
        [404, 405, 501, 503].includes(response.status) ? 'unavailable' : 'failed',
      );
    const body = await response.json();
    if (
      body.messageId !== request.transcript.at(-1)?.id ||
      body.chain !== chain ||
      typeof body.address !== 'string' ||
      !sameAddress(chain, body.address, address)
    )
      throw new VaultAgentError('failed');
    return body;
  };
}
