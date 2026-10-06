export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

export type PlanDetail = {
  plan: {
    id: string;
    profile: string;
    capitalUsd: string;
    wallet: string | null;
    solverVersion: string;
    bindingConstraints: string[];
    disclaimer: string;
    createdAt: string;
  };
  goal: { rawText: string; language: string } | null;
  sheet: {
    sheet: Record<string, unknown>;
    valid: boolean;
    origin: string;
    provenance: string;
  } | null;
  legs: Array<{
    id: string;
    assetId: string;
    symbol: string;
    name: string;
    kind?: string;
    mintPath?: string;
    weight: string;
    amountUsd: string;
    reasoning: string;
    label: string | null;
  }>;
  schedules: Array<{ caseId: string; rows: unknown[]; liquidityOk: boolean }>;
  stresses: Array<{
    stressId: string;
    name: string;
    params: Record<string, number>;
    liquidityOk: boolean;
  }>;
  riskSheet: Array<{ assetId: string; entry: Record<string, unknown> }>;
  policy: {
    id: string;
    allowedAssets: string[];
    bands: Array<{ assetId: string; min: number; max: number }>;
    trigger: { driftPct: number; minIntervalHours: number };
    mechanism: string;
    mechanismByAsset: Record<string, string>;
  } | null;
  executions: Array<{
    id: string;
    kind: string;
    assetId: string | null;
    status: string;
    signature: string | null;
    explorerUrl: string | null;
    createdAt: string;
  }>;
  disclaimer: { pt: string; en: string };
};
