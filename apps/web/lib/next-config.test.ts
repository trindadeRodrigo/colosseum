import { describe, expect, it } from 'vitest';
import config from '../next.config';
import { frameHeaders } from './frame-policy';
import { securityHeaders } from './security-headers';

// The framing policy and the security headers are what the app's config hands Next, in every phase.

describe('the app’s config', () => {
  it('hands Next the framing policy and the security headers', async () => {
    for (const phase of ['phase-development-server', 'phase-production-build']) {
      const made = config(phase);
      expect(await made.headers?.()).toEqual([...frameHeaders(process.env), ...securityHeaders()]);
    }
  });
});
