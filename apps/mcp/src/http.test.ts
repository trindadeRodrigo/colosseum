import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { configOf, MAX_BODY_BYTES, serveNode } from './http';
import { createTenonfiMcp } from './server';

// The server on Node's HTTP server, as a host runs it (`pnpm --filter @colosseum/mcp start`): its
// settings from the environment, `/mcp` and `/health`, and a browser page refused.

describe('the settings', () => {
  it('default to the hosted API and port 8787, and read nothing else', () => {
    expect(configOf({ SECRET: 'x', TENONFI_APP_URL: 'https://app.example' })).toEqual({
      apiUrl: 'https://tenonfi-api.onrender.com',
      appUrl: 'https://app.example',
      port: 8787,
      host: '0.0.0.0',
      allowedOrigins: [],
    });
    // the app on this machine only for a server that listens on this machine alone
    expect(configOf({ HOST: '127.0.0.1' }).appUrl).toBe('http://localhost:3000');
    expect(
      configOf({
        TENONFI_API_URL: 'https://api.example/ignored/path',
        TENONFI_APP_URL: 'https://app.example',
        PORT: '10000',
        MCP_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
      }),
    ).toMatchObject({
      apiUrl: 'https://api.example',
      appUrl: 'https://app.example',
      port: 10_000,
      allowedOrigins: ['https://a.example', 'https://b.example'],
    });
  });

  it('refuse an address that is not https, but on this machine, and a port that is not one', () => {
    expect(() => configOf({ TENONFI_API_URL: 'http://api.example' })).toThrow(/https/);
    expect(() => configOf({ TENONFI_APP_URL: 'javascript:alert(1)' })).toThrow(/https/);
    expect(() => configOf({ PORT: 'eighty', HOST: '127.0.0.1' })).toThrow(/PORT/);
    // a server others reach is told where the app is, and it is not this machine
    expect(() => configOf({})).toThrow(/TENONFI_APP_URL is required/);
    expect(() => configOf({ TENONFI_APP_URL: 'http://localhost:3000' })).toThrow(/this machine/);
  });
});

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function listen(allowedOrigins: string[] = []) {
  const config = { ...configOf({ HOST: '127.0.0.1' }), allowedOrigins };
  const mcp = createTenonfiMcp(config, async () => Response.json({ error: 'no' }, { status: 404 }));
  server = createServer(serveNode(mcp, config));
  await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const list = (base: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

describe('the HTTP server', () => {
  it('serves the tools at /mcp, says it is up at /health, and serves nothing else', async () => {
    const base = await listen();
    const res = await list(base);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"name":"build_plan"');
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
    expect((await fetch(`${base}/`)).status).toBe(404);
    // what an agent reads first, with this deployment's own addresses, and the API's document
    const llms = await (await fetch(`${base}/llms.txt`)).text();
    expect(llms).toContain(`MCP server (Streamable HTTP, no login): ${base}/mcp`);
    expect(llms).toContain('App: http://localhost:3000');
    expect(llms).toContain('build_plan');
    expect(llms).toContain("carries the API's disclaimer");
    const doc = (await (await fetch(`${base}/openapi.json`)).json()) as { paths: object };
    expect(Object.keys(doc.paths)).toContain('/v1/baskets/propose');
    expect((await fetch(`${base}/mcp/../health`)).status).toBe(200);
  });

  it('refuses a browser page from an origin it was not given', async () => {
    const base = await listen(['https://allowed.example']);
    expect((await list(base, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await list(base, { origin: 'https://allowed.example' })).status).toBe(200);
  });

  it('reads no body larger than a call can be, whether or not its length is said', async () => {
    const base = await listen();
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { pad: 'x'.repeat(MAX_BODY_BYTES) },
    });
    const send = (body: BodyInit, more: object = {}) =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body,
        ...more,
      });
    const said = await send(big);
    expect([said.status, await said.json()]).toEqual([413, { error: 'the request is too large' }]);
    // sent in pieces, with no length up front
    const pieces = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 4; i++)
          controller.enqueue(new TextEncoder().encode(big.slice(0, 40_000)));
        controller.close();
      },
    });
    const streamed = await send(pieces, { duplex: 'half' }).then(
      (res) => res.status,
      () => 'closed',
    );
    expect([413, 'closed']).toContain(streamed);
    // and a call of the usual size is answered as before
    expect((await list(base)).status).toBe(200);
  });
});
