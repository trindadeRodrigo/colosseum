// Who may put this app in a frame (embed-shell.md; binding rule 7). The partner embed's two pages
// (`/embed` and `/embed/<chain>/<address>`) may be framed by this app and by the partners a deployment
// names, and by nobody else; every other address, any other under `/embed` included, may not be
// framed at all, so no page that signs or signs in can be laid under another site's clicks.
// `headers()` is read when the app is built (it is written into routes-manifest.json), so a new
// partner takes a rebuild, not a restart.
//
// EMBED_FRAME_ANCESTORS: the partners' origins, space-separated, each `https://host[:port]` exactly
// (no path, no wildcard). An entry in any other form is dropped, never widened.

export type FrameRule = { source: string; headers: { key: string; value: string }[] };

const ORIGIN =
  /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/i;

/** The partners' origins a deployment names, each checked. */
export function partnerOrigins(value: string | undefined): string[] {
  return (value ?? '').split(/\s+/).filter((origin) => ORIGIN.test(origin));
}

/** The headers of a page nobody may frame. */
export const FRAMED_BY_NOBODY = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
];

/**
 * The embed's two pages, exactly. Next matches a header's `source` without regard to case, while
 * its routes keep it: `/Embed/a/b` takes the rule below and is not the embed, but the page for an
 * address no route has. The proxy (proxy.ts) holds such an address to nobody, by this test.
 */
export const isEmbedPage = (pathname: string) => /^\/embed(\/[^/]+\/[^/]+)?$/.test(pathname);

export function frameHeaders(env: Record<string, string | undefined>): FrameRule[] {
  const partners = partnerOrigins(env.EMBED_FRAME_ANCESTORS);
  const partnerPolicy = [
    { key: 'Content-Security-Policy', value: ["frame-ancestors 'self'", ...partners].join(' ') },
  ];
  return [
    { source: '/embed', headers: partnerPolicy },
    { source: '/embed/:chain/:address', headers: partnerPolicy },
    {
      // every address but those two: `/embed/x`, `/embed/a/b/c` and the rest fall to a page that is
      // not the embed's, and are framed by nobody
      source: '/:path((?!embed(?:/[^/]+/[^/]+)?$).*)',
      headers: FRAMED_BY_NOBODY,
    },
  ];
}
