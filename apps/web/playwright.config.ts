import { defineConfig, devices } from '@playwright/test';

// The end-to-end spec of the app (DESIGN-VAULT section 11, "Checks"): every screen it opens is checked
// with axe at 375 px, in light and dark. It runs the app under `next dev` with the throwaway wallet, in
// front of a stub of the API on the mock chain (tests/e2e/stub-api.ts). `pnpm --filter @colosseum/web
// e2e`; CI runs it in its own job. Nothing here reaches a real chain or a real sign-in.

// Two checkouts on one machine each run their own: E2E_WEB_PORT and E2E_API_PORT move them, so a
// server another checkout left up is never taken for this one's.
const WEB = Number(process.env.E2E_WEB_PORT ?? 3100);
const API = Number(process.env.E2E_API_PORT ?? 3901);
const MCP = Number(process.env.E2E_MCP_PORT ?? 3902);

export default defineConfig({
  testDir: './e2e',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'e2e/.results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 375, height: 812 },
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm exec tsx ../../tests/e2e/stub-api.ts',
      url: `http://localhost:${API}/v1/config`,
      env: { STUB_API_PORT: String(API), WEB_ORIGIN: `http://localhost:${WEB}` },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // The MCP server in front of the stub (AGT-2), for the spec of an agent's plan (agent.spec.ts).
      command: 'pnpm --filter @colosseum/mcp start',
      url: `http://localhost:${MCP}/health`,
      env: {
        TENONFI_API_URL: `http://localhost:${API}`,
        TENONFI_APP_URL: `http://localhost:${WEB}`,
        PORT: String(MCP),
        HOST: '127.0.0.1',
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `pnpm exec next dev -p ${WEB}`,
      url: `http://localhost:${WEB}/sign-in`,
      env: {
        NEXT_PUBLIC_API_URL: `http://localhost:${API}`,
        NEXT_PUBLIC_WALLET_DRIVER: 'test',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
  ],
});
