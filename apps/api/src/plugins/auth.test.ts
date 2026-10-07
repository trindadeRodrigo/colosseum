import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { person, type TestIssuer, testIssuer } from '../testing/harness';
import { enforceSignIn, identify } from './auth';

// A public route that reads a sign-in when one is sent (`config.optionalSignIn`): the route a plan is
// read back by, which answers a plan from a link to anybody and a person's own plan to that person.
// The sign-in opens the caller's own and nothing else, and is never needed.

let issuer: TestIssuer;
let other: TestIssuer;
beforeAll(async () => {
  issuer = await testIssuer('optional');
  other = await testIssuer('elsewhere');
});

const served = () => {
  const app = Fastify();
  identify(app, issuer.issuer);
  enforceSignIn(app);
  const who = async (req: { principal: { userId?: string } | null }) => ({
    who: req.principal?.userId ?? null,
  });
  app.get('/own', { config: { auth: 'public', optionalSignIn: true } }, who);
  app.get('/open', { config: { auth: 'public' } }, who);
  app.get('/mine', { config: { auth: 'user' } }, who);
  return (url: string, headers: Record<string, string> = {}) => app.inject({ url, headers });
};

describe('a public route that reads a sign-in when one is sent', () => {
  it('knows the person who is signed in, and answers nobody as nobody', async () => {
    const get = served();
    const a = await person(issuer, 'solana');
    const signedIn = await get('/own', a.headers);
    expect([signedIn.statusCode, signedIn.json()]).toEqual([200, { who: a.sub }]);
    const nobody = await get('/own');
    expect([nobody.statusCode, nobody.json()]).toEqual([200, { who: null }]);
  });

  it('answers a sign-in that is not valid as nobody, never 401, and never as somebody', async () => {
    const get = served();
    const a = await person(issuer, 'solana');
    const stranger = await person(other, 'solana');
    const forged = [
      { authorization: 'Bearer not-a-token', 'privy-id-token': 'nor-this' },
      // another issuer's tokens, valid there
      stranger.headers,
      // the access token alone: no identity, so no wallets and nobody
      { authorization: a.headers.authorization ?? '' },
    ];
    for (const headers of forged) {
      const res = await get('/own', headers);
      expect([res.statusCode, res.json()]).toEqual([200, { who: null }]);
    }
  });

  it('is the only kind that reads one: a plain public route knows nobody, and a user route still needs one', async () => {
    const get = served();
    const a = await person(issuer, 'solana');
    expect((await get('/open', a.headers)).json()).toEqual({ who: null });
    expect((await get('/mine')).statusCode).toBe(401);
    expect((await get('/mine', a.headers)).json()).toEqual({ who: a.sub });
  });
});
