import { type ApiFetch, ApiRefusal } from '../executor/api';
import type { ApiRoutes } from './types';

// The API's routes over `fetch`, typed from its OpenAPI document (src/api/types.ts, generated): what the
// MCP server and any other agent read and write through (DESIGN-VAULT section 12). It holds no key and
// signs nothing; a route that needs a person is answered only when `fetch` carries their sign-in.
//
// One route is not in the document: Bearing's fact sheet for one asset, under `/risk`, which is the risk
// layer's and is documented with it. Its answer is typed here by hand, as far as an agent reads it.

type Route = keyof ApiRoutes;
type Part<R extends Route, K extends string> = ApiRoutes[R] extends { [P in K]: infer T }
  ? T
  : never;

/** What one route takes: its path parameters, its query and its body, each where it has one. */
export type ApiInput<R extends Route> = ([Part<R, 'params'>] extends [never]
  ? { params?: never }
  : { params: Part<R, 'params'> }) &
  ([Part<R, 'query'>] extends [never] ? { query?: never } : { query?: Part<R, 'query'> }) &
  ([Part<R, 'body'>] extends [never] ? { body?: never } : { body: Part<R, 'body'> });

/** What one route answers with a 200. */
export type ApiOutput<R extends Route> = Part<R, 'response'>;

/** Bearing's fact sheet for one asset at one trade size (`GET /risk/facts/assets/{id}`), as read here. */
export type AssetRiskFacts = {
  /** Every fact Bearing has on the asset: a fact with no data is null with its reason, never zero. */
  [key: string]: unknown;
  disclaimer: string;
};

/** Puts the path parameters into a route's path, each encoded. */
export function pathOf(path: string, params: Record<string, string> = {}): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`no value for {${name}} in ${path}`);
    return encodeURIComponent(value);
  });
}

function queryOf(query: Record<string, unknown> | undefined): string {
  const pairs = Object.entries(query ?? {}).filter(([, v]) => v !== undefined);
  if (pairs.length === 0) return '';
  return `?${new URLSearchParams(pairs.map(([k, v]) => [k, String(v)])).toString()}`;
}

export type TenonfiClient = {
  /** Any route of the document, by its method and path. A refusal is thrown as an `ApiRefusal`. */
  call<R extends Route>(route: R, input?: ApiInput<R>): Promise<ApiOutput<R>>;
  /** Bearing's fact sheet for one asset, by its symbol or mint, at a trade size in dollars. */
  assetRisk(asset: string, sizeUsd?: number): Promise<AssetRiskFacts>;
};

/** The client over `fetch`. Every answer that is not a 2xx is thrown as an `ApiRefusal`. */
export function createTenonfiClient(fetchApi: ApiFetch): TenonfiClient {
  const send = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetchApi(path, {
      method,
      // A request with no body carries no content type: the API refuses an empty JSON body.
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const answer = await res.json().catch(() => null);
    if (res.ok) return answer as T;
    const said =
      typeof answer === 'object' && answer !== null && 'error' in answer
        ? (answer as ApiRefusal['body'])
        : { error: `the API answered ${res.status}` };
    throw new ApiRefusal(res.status, said);
  };
  return {
    call: (route, input) => {
      const [method = 'GET', path = ''] = String(route).split(' ');
      const given = (input ?? {}) as {
        params?: Record<string, string>;
        query?: Record<string, unknown>;
        body?: unknown;
      };
      return send(method, pathOf(path, given.params) + queryOf(given.query), given.body);
    },
    assetRisk: (asset, sizeUsd) =>
      send('GET', `/risk/facts/assets/${encodeURIComponent(asset)}${queryOf({ sizeUsd })}`),
  };
}
