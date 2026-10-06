import { describe, expect, it, vi } from 'vitest';
import { makeReader } from './data';

// The reader of the risk API: an answer is kept for the life of the page, a failure is not, and the
// API is asked three times, a second apart, before the page says it did not answer.

const answer = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('the reader of the risk API', () => {
  it('keeps an answer: the same route is read once', async () => {
    const fetcher = vi.fn(() => answer(200, { ok: 1 }));
    const r = makeReader('http://api', fetcher as unknown as typeof fetch);
    await r.get('/risk/assets?tau=0.01');
    const again = await r.get('/risk/assets?tau=0.01');
    expect(again.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a 404 too: the API said it has no such route', async () => {
    const fetcher = vi.fn(() => answer(404, { message: 'Route GET:/risk/x not found' }));
    const r = makeReader('http://api', fetcher as unknown as typeof fetch);
    expect((await r.get('/risk/x')).reason).toBe('not_served');
    await r.get('/risk/x');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failure: no answer, or the server’s own error, is asked again', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('down')))
      .mockImplementationOnce(() => answer(503, { error: 'busy' }))
      .mockImplementation(() => answer(200, { ok: 1 }));
    const r = makeReader('http://api', fetcher as unknown as typeof fetch);
    expect((await r.get('/risk/pools')).reason).toBe('api_error');
    expect((await r.get('/risk/pools')).reason).toBe('api_error');
    expect((await r.get('/risk/pools')).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('asks again when the first probe finds nothing, and says up once one answers', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('slow')))
      .mockImplementation(() => answer(200, { methodVersion: 'risk-0.3' }));
    const r = makeReader('http://api', fetcher as unknown as typeof fetch);
    expect(await r.probe()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
