import { Writable } from 'node:stream';
import { ChainError } from '@colosseum/schemas';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { hideNodeUrls, loggerOptions, nodeUrls } from './redact';

// No node URL reaches a server log (the keeper's `hide`, for the API): the configured ones by their
// setting's name, and any "URL: …" a library's error carries.

const ENV = {
  SOLANA_RPC_URL: 'https://solana.example.invalid/?api-key=SOLKEY123',
  ROBINHOOD_RPC_URL: 'https://rh.example.invalid/v2/RHKEY456',
  SOLANA_RPC_URL_FALLBACK: 'https://backup.example.invalid/BKEY789',
  PORT: '3001',
};
const KEYS = /SOLKEY123|RHKEY456|BKEY789|elsewhere\.example/;

/** viem's error when a node does not answer, wrapped as the readers wrap it. */
function viemStyle(url: string) {
  const raw = new Error(`HTTP request failed.\n\nURL: ${url}\nRequest body: {"method":"eth_call"}`);
  const error = new ChainError('Unknown', raw.message);
  error.cause = raw;
  return error;
}

describe('a server log', () => {
  it('names each configured node by its setting, and cuts any URL a library names', () => {
    const urls = nodeUrls(ENV);
    expect(urls.map(([name]) => name).sort()).toEqual([
      'ROBINHOOD_RPC_URL',
      'SOLANA_RPC_URL',
      'SOLANA_RPC_URL_FALLBACK',
    ]);
    expect(hideNodeUrls(`failed on ${ENV.ROBINHOOD_RPC_URL} twice`, urls)).toBe(
      'failed on <ROBINHOOD_RPC_URL> twice',
    );
    expect(hideNodeUrls('HTTP request failed.\n\nURL: https://elsewhere.example/k', urls)).toBe(
      'HTTP request failed.\n\nURL: <hidden>',
    );
  });

  it('never receives a node URL: not from a route’s own log, not from the error handler’s', async () => {
    let written = '';
    const stream = new Writable({
      write(chunk, _enc, done) {
        written += chunk.toString();
        done();
      },
    });
    const app = Fastify({ logger: { ...loggerOptions(ENV), stream } });
    // as the portfolio logs a chain it could not read, and as a route that throws is logged
    app.get('/logged', async (req) => {
      req.log.error({ err: viemStyle(ENV.ROBINHOOD_RPC_URL), chain: 'robinhood' }, 'read failed');
      req.log.warn(`could not reach ${ENV.SOLANA_RPC_URL}`);
      return { ok: true };
    });
    app.get('/thrown', async () => {
      throw viemStyle('https://elsewhere.example/v1/OTHERKEY');
    });
    await app.inject({ method: 'GET', url: '/logged' });
    await app.inject({ method: 'GET', url: '/thrown' });
    await app.close();
    expect(written).toContain('read failed');
    expect(written).toContain('<ROBINHOOD_RPC_URL>');
    expect(written).toContain('<SOLANA_RPC_URL>');
    expect(written).toContain('URL: <hidden>');
    expect(written).not.toMatch(KEYS);
    expect(written).not.toContain('OTHERKEY');
  });
});
