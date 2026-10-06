import { type NextRequest, NextResponse } from 'next/server';
import { FRAMED_BY_NOBODY, isEmbedPage } from './lib/frame-policy';

// The frame policy's last word (lib/frame-policy.ts): next.config.ts gives the embed's two addresses
// the partners' policy, matched without regard to case; an address that took it and is not one of
// the two, exactly, is held to nobody here.

export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  if (!isEmbedPage(request.nextUrl.pathname))
    for (const { key, value } of FRAMED_BY_NOBODY) response.headers.set(key, value);
  return response;
}

// Next matches a proxy's paths with their case, so the matcher spells each letter both ways: every
// address the rule in next.config.ts takes reaches this function, and no other.
export const config = {
  matcher: ['/([eE][mM][bB][eE][dD])', '/([eE][mM][bB][eE][dD])/:path*'],
};
