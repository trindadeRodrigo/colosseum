// Who may put this app in a frame (embed-shell.md; binding rule 7). The partner embed (`/embed…`) may
// be framed by this app and by the partners a deployment names, and by nobody else; every other page
// may not be framed at all, so no page that signs or signs in can be laid under another site's
// clicks. Read once, when the app starts (next.config.ts).
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

export function frameHeaders(env: Record<string, string | undefined>): FrameRule[] {
  const partners = partnerOrigins(env.EMBED_FRAME_ANCESTORS);
  return [
    {
      source: '/embed/:path*',
      headers: [
        {
          key: 'Content-Security-Policy',
          value: ["frame-ancestors 'self'", ...partners].join(' '),
        },
      ],
    },
    {
      // every page but the embed (`/embed/:path*` takes `/embed` itself too)
      source: '/:path((?!embed(?:/|$)).*)',
      headers: [
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        { key: 'X-Frame-Options', value: 'DENY' },
      ],
    },
  ];
}
