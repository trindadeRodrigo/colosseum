import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import openapi from '@colosseum/sdk/openapi.json' with { type: 'json' };
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { llmsTxt } from './llms';
import type { McpConfig } from './server';

// The MCP handler on Node's HTTP server: `/mcp` is the server, `/llms.txt` says what it is to an agent
// (AGT-3), `/openapi.json` is the API's document the tools are cut from, `/health` says it is up, and
// nothing else is served. A request from a browser page (it carries `Origin`) is refused unless that origin is
// allowed, so a page cannot drive the server from a person's browser.

export type ServeConfig = McpConfig & {
  port: number;
  host: string;
  /** Browser origins that may call /mcp. Empty: none. */
  allowedOrigins: string[];
};

const DEFAULT_API = 'https://tenonfi-api.onrender.com';
const DEFAULT_APP = 'http://localhost:3000';

/** An address the server may point at: https, or http on this machine. */
function addressOf(name: string, value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new Error(`${name} must be https, or http on localhost: ${value}`);
  return url.origin;
}

/** The settings, from the environment the process was given. Reads nothing else. */
export function configOf(env: Record<string, string | undefined>): ServeConfig {
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`PORT: ${env.PORT}`);
  return {
    apiUrl: addressOf('TENONFI_API_URL', env.TENONFI_API_URL ?? DEFAULT_API),
    appUrl: addressOf('TENONFI_APP_URL', env.TENONFI_APP_URL ?? DEFAULT_APP),
    port,
    host: env.HOST ?? '0.0.0.0',
    allowedOrigins: (env.MCP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}

/** A Node request as a web-standard one. */
function requestOf(req: IncomingMessage, base: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers))
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : Readable.toWeb(req);
  return new Request(new URL(req.url ?? '/', base), {
    method,
    headers,
    body: body as ReadableStream | undefined,
    // A streamed body needs this in Node's fetch.
    ...(body ? { duplex: 'half' } : {}),
  } as RequestInit);
}

async function write(res: ServerResponse, answer: Response): Promise<void> {
  res.statusCode = answer.status;
  answer.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  if (!answer.body) return void res.end();
  for await (const chunk of Readable.fromWeb(answer.body as never)) res.write(chunk);
  res.end();
}

/** The Node request listener. */
export function serveNode(mcp: McpHttpHandler, config: ServeConfig) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0];
    const reply = async () => {
      if (path === '/health') return write(res, Response.json({ ok: true }));
      if (path === '/openapi.json') return write(res, Response.json(openapi));
      if (path === '/llms.txt') {
        const self = `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host ?? `localhost:${config.port}`}`;
        const text = llmsTxt({
          mcpUrl: `${self}/mcp`,
          apiUrl: config.apiUrl,
          appUrl: config.appUrl,
        });
        return write(
          res,
          new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
        );
      }
      if (path !== '/mcp')
        return write(res, Response.json({ error: 'not found' }, { status: 404 }));
      const origin = req.headers.origin;
      if (origin !== undefined && !config.allowedOrigins.includes(origin))
        return write(
          res,
          Response.json({ error: 'this origin may not call the server' }, { status: 403 }),
        );
      return write(
        res,
        await mcp.fetch(requestOf(req, `http://${req.headers.host ?? 'localhost'}`)),
      );
    };
    reply().catch(() => {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  };
}
