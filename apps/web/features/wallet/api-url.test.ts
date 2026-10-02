import { describe, expect, it } from 'vitest';
import { apiUrl } from './api-url';

// useApiFetch() adds the sign-in token to the call, so where the call goes is not left to the caller.

const API = 'http://localhost:3001';

describe('apiUrl: the token goes to the API and nowhere else', () => {
  it('joins a path to the API', () => {
    expect(apiUrl(API, '/v1/config')).toBe('http://localhost:3001/v1/config');
    expect(apiUrl(`${API}/`, '/v1/orders?limit=3')).toBe('http://localhost:3001/v1/orders?limit=3');
    expect(apiUrl('https://api.example.org', '/v1/orders/abc/legs/1/build')).toBe(
      'https://api.example.org/v1/orders/abc/legs/1/build',
    );
  });

  it('keeps a path the API is mounted under, and does not let a path climb out of it', () => {
    expect(apiUrl('https://example.org/api', '/v1/config')).toBe(
      'https://example.org/api/v1/config',
    );
    expect(() => apiUrl('https://example.org/api', '/../admin')).toThrow('outside the API');
    expect(() => apiUrl('https://example.org/api', '/v1/../../admin')).toThrow('outside the API');
  });

  it('refuses a path that would name another host', () => {
    for (const path of [
      '@evil.example/v1/config', // http://localhost:3001@evil.example/...: the API becomes a user name
      '.evil.example/v1/config', // http://localhost:3001.evil.example/...
      ':80@evil.example/',
      '//evil.example/v1/config',
      '/\\evil.example/v1/config',
      '\\\\evil.example/v1/config',
      'https://evil.example/v1/config',
      'v1/config',
      '',
      ' /v1/config',
    ])
      expect(() => apiUrl(API, path), path).toThrow('the path must start with one /');
  });

  it('refuses an API address that is not an http address', () => {
    expect(() => apiUrl('/api', '/v1/config')).toThrow();
    expect(() => apiUrl('javascript:alert(1)//', '/v1/config')).toThrow('not an http address');
  });
});
