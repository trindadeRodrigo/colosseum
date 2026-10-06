import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import { frameHeaders } from './lib/frame-policy';

// The env file lives at the repo root; Next only reads its own directory. Existing variables win.
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@colosseum/schemas', '@colosseum/sdk'],
  // The /risk pages became Bearing's analytics (/analytics); their addresses still lead there.
  async redirects() {
    return [
      { source: '/risk', destination: '/analytics/stocks', permanent: false },
      { source: '/risk/methodology', destination: '/analytics/methodology', permanent: false },
      { source: '/risk/:asset', destination: '/analytics/stocks?asset=:asset', permanent: false },
    ];
  },
};

// A development-only route is a file named `page.dev.tsx`: a route under `next dev`, a plain file in
// every other phase, so `next build` has no such route and bundles none of what it imports.
const ROUTES = ['tsx', 'ts', 'jsx', 'js'];
export default function config(phase: string): NextConfig {
  const dev = phase === PHASE_DEVELOPMENT_SERVER;
  return { ...nextConfig, pageExtensions: dev ? ['dev.tsx', ...ROUTES] : ROUTES };
}
