import { describe, expect, it } from 'vitest';
import { hiderFromEnv } from './hide';

// No node address, database address or ping address in a line of the worker.

const ENV = {
  SOLANA_RPC_URL: 'https://solana.example.invalid/?api-key=SOLKEY123',
  ROBINHOOD_RPC_URL: ' https://rh.example.invalid/v2/RHKEY456 ',
  SOLANA_RPC_URL_FALLBACK: 'https://solana.example.invalid/?api-key=SOLKEY123&backup=BKEY789',
  RISK_SOLANA_RPC_URL: 'https://risk.example.invalid/RISKKEY',
  DATABASE_URL: 'postgres://worker:DBPASS@db.example.invalid:5432/tenonfi',
  SNAPSHOT_PING_URL: 'https://hc.example.invalid/ping/PINGKEY',
  BASE_RPC_URL: '   ',
  PORT: '3001',
};
const SECRETS = /SOLKEY123|RHKEY456|BKEY789|RISKKEY|DBPASS|PINGKEY|elsewhere\.example/;

describe("the worker's hider", () => {
  const hide = hiderFromEnv(ENV);

  it('names each configured address by its setting', () => {
    expect(hide(`no answer from ${ENV.SOLANA_RPC_URL} twice`)).toBe(
      'no answer from <SOLANA_RPC_URL> twice',
    );
    // as the value is used: trimmed
    expect(hide('failed on https://rh.example.invalid/v2/RHKEY456.')).toBe(
      'failed on <ROBINHOOD_RPC_URL>.',
    );
    expect(hide(`connect ECONNREFUSED ${ENV.DATABASE_URL}`)).toBe(
      'connect ECONNREFUSED <DATABASE_URL>',
    );
    expect(hide(`${ENV.RISK_SOLANA_RPC_URL} and ${ENV.SNAPSHOT_PING_URL}`)).toBe(
      '<RISK_SOLANA_RPC_URL> and <SNAPSHOT_PING_URL>',
    );
  });

  it('takes the longer address out whole when one contains another', () => {
    expect(hide(`tried ${ENV.SOLANA_RPC_URL_FALLBACK}`)).toBe('tried <SOLANA_RPC_URL_FALLBACK>');
  });

  it('cuts any other URL a transport error names, and leaves a named one named', () => {
    expect(hide('HTTP request failed.\n\nURL: https://elsewhere.example/k\nRequest body: {}')).toBe(
      'HTTP request failed.\n\nURL: <hidden>\nRequest body: {}',
    );
    expect(hide(`HTTP request failed.\n\nURL: ${ENV.SOLANA_RPC_URL}`)).toBe(
      'HTTP request failed.\n\nURL: <SOLANA_RPC_URL>',
    );
  });

  it('leaves nothing of any of them in a long line, and other text as it was', () => {
    const line = [
      `a ${ENV.SOLANA_RPC_URL}`,
      `b ${ENV.ROBINHOOD_RPC_URL.trim()}`,
      `c ${ENV.SOLANA_RPC_URL_FALLBACK}`,
      `d ${ENV.RISK_SOLANA_RPC_URL}`,
      `e ${ENV.DATABASE_URL}`,
      `f ${ENV.SNAPSHOT_PING_URL}`,
      'URL: https://elsewhere.example/v1/OTHER',
    ].join('; ');
    expect(hide(line)).not.toMatch(SECRETS);
    expect(hide('the Solana RPC did not answer getMultipleAccounts on port 3001')).toBe(
      'the Solana RPC did not answer getMultipleAccounts on port 3001',
    );
  });

  it('is the text itself with nothing set, and an empty setting hides nothing', () => {
    expect(hiderFromEnv({})('plain text')).toBe('plain text');
    expect(hiderFromEnv({ SOLANA_RPC_URL: '', DATABASE_URL: undefined })('a b c')).toBe('a b c');
    // BASE_RPC_URL is spaces only: not a value, so no space is replaced
    expect(hide('a b c')).toBe('a b c');
  });
});
