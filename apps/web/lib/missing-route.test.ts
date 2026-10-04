import { describe, expect, it } from 'vitest';
import { isMissingRoute } from './missing-route';

describe('a 404 from the API', () => {
  it('is a route the server does not have when the framework answers it', () => {
    expect(
      isMissingRoute(404, {
        message: 'Route POST:/policies/1b4e28ba-2fa1-11d2-883f-0016d3cca427/rebalance not found',
        error: 'Not Found',
        statusCode: 404,
      }),
    ).toBe(true);
  });

  it('is not one when the route is there and found nothing, or when it is no 404 at all', () => {
    expect(isMissingRoute(404, { error: 'policy not found' })).toBe(false);
    expect(isMissingRoute(404, { error: 'Not Found' })).toBe(false);
    expect(isMissingRoute(404, null)).toBe(false);
    expect(isMissingRoute(404, 'Route POST:/x not found')).toBe(false);
    expect(isMissingRoute(404, { message: 'policy not found', statusCode: 404 })).toBe(false);
    expect(isMissingRoute(500, { message: 'Route POST:/x not found', statusCode: 404 })).toBe(
      false,
    );
  });
});
