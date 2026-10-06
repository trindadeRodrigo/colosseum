import { describe, expect, it } from 'vitest';
import config from '../next.config';
import { frameHeaders } from './frame-policy';

// The framing policy is what the app's config hands Next, in every phase.

describe('the app’s config', () => {
  it('hands Next the framing policy', async () => {
    for (const phase of ['phase-development-server', 'phase-production-build']) {
      const made = config(phase);
      expect(await made.headers?.()).toEqual(frameHeaders(process.env));
    }
  });
});
