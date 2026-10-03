// DA4 (PLAN-ANALYTICS): wallet-level data stays local. A fixture of frozen mainnet transactions keeps its shape but
// not its wallets: every token-account owner, every liquidator and every transaction signature is replaced, the same
// value by the same stand-in everywhere in the file, so the functions under test (which compare owners and
// signatures only for equality) see what they saw before. Programs, mints, pools and vaults are kept.
const OWNER_KEYS = new Set(['owner', 'liquidator']);
const SIGNATURE_KEYS = /^(s|signature|outSignature)$/;

export function pseudonymise(json: string): string {
  const owners = new Set<string>();
  const signatures = new Set<string>();
  const walk = (v: unknown, key: string | null) => {
    if (typeof v === 'string') {
      if (key && OWNER_KEYS.has(key)) owners.add(v);
      else if (key && (SIGNATURE_KEYS.test(key) || key === 'signatures')) signatures.add(v);
    } else if (Array.isArray(v)) for (const x of v) walk(x, key === 'signatures' ? key : null);
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
  };
  walk(JSON.parse(json), null);
  const map = new Map<string, string>();
  for (const [i, v] of [...owners].sort().entries())
    map.set(v, `wallet-${String(i + 1).padStart(3, '0')}`);
  for (const [i, v] of [...signatures].sort().entries())
    map.set(v, `sig-${String(i + 1).padStart(3, '0')}`);
  // longest first, so no value is replaced inside a longer one
  let out = json;
  for (const v of [...map.keys()].sort((a, b) => b.length - a.length))
    out = out.split(v).join(map.get(v) as string);
  return out;
}
