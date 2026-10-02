import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

// The env file lives at the repo root; Next only reads its own directory. Existing variables win.
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@colosseum/schemas'],
};
export default nextConfig;
