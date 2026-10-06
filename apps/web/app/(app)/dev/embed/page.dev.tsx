import { EmbedHost } from './EmbedHost';

// A stand-in partner app for the embed (embed-shell.md), under `next dev` only: the embed in three
// skins (the system's light, the system's dark, and the guide's sample partner), in frames sized by
// the height each one posts. `?vault=solana/<address>` adds the vault view; `?width=375` narrows the
// partner's column.

export default async function DevEmbedPage({
  searchParams,
}: {
  searchParams: Promise<{ vault?: string; width?: string }>;
}) {
  const { vault, width } = await searchParams;
  return <EmbedHost vault={vault ?? null} width={width === '375' ? 375 : 560} />;
}
