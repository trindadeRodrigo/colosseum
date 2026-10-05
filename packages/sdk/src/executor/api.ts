import type {
  BuildLegResponse,
  IntentRequest,
  OrderDetail,
  OrderError,
  ReportLegRequest,
} from '@colosseum/schemas';

// The order routes of the API (DESIGN-VAULT 3.3), as the executor calls them. The executor takes any
// object of this shape: the client below over `fetch`, or a double in a test.

export type OrderApi = {
  /** POST /v1/orders: plans the steps of an order. Nothing is built or signed. */
  createOrder(intent: IntentRequest): Promise<OrderDetail>;
  /** GET /v1/orders/{id}: the order as it stands, with steps that were sent tracked again first. */
  getOrder(orderId: string): Promise<OrderDetail>;
  /** POST .../legs/{legId}/build: a fresh unsigned transaction and the attempt that records it. */
  buildLeg(orderId: string, legId: string): Promise<BuildLegResponse>;
  /** POST .../legs/{legId}/report: the step was sent, by its id or by signed bytes to relay. */
  reportLeg(orderId: string, legId: string, body: ReportLegRequest): Promise<OrderDetail>;
  /** POST .../legs/{legId}/cancel: the latest attempt will not be sent. */
  cancelLeg(orderId: string, legId: string): Promise<OrderDetail>;
};

/** The API said no: its status and its body, which is the shared `OrderError`. */
export class ApiRefusal extends Error {
  readonly status: number;
  readonly body: OrderError;
  constructor(status: number, body: OrderError) {
    super(body.error);
    this.name = 'ApiRefusal';
    this.status = status;
    this.body = body;
  }
}

export const isApiRefusal = (e: unknown): e is ApiRefusal =>
  e instanceof ApiRefusal ||
  (typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'ApiRefusal' &&
    typeof (e as { status?: unknown }).status === 'number');

/** What the client needs of `fetch`: the web's `useApiFetch()` fits, and so does `fetch` with a base URL. */
export type ApiFetch = (
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The order routes over `fetch`. Every answer that is not a 2xx is thrown as an `ApiRefusal`. */
export function createOrderApi(fetchApi: ApiFetch): OrderApi {
  const request = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    const res = await fetchApi(path, {
      method,
      // A POST with no body carries no content type: the API refuses an empty JSON body.
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const answer = await res.json().catch(() => null);
    if (res.ok) return answer as T;
    const said =
      typeof answer === 'object' && answer !== null && 'error' in answer
        ? (answer as OrderError)
        : { error: `the API answered ${res.status}` };
    throw new ApiRefusal(res.status, said);
  };
  const id = encodeURIComponent;
  const leg = (orderId: string, legId: string, step: string) =>
    `/v1/orders/${id(orderId)}/legs/${id(legId)}/${step}`;
  return {
    createOrder: (intent) => request('POST', '/v1/orders', intent),
    getOrder: (orderId) => request('GET', `/v1/orders/${id(orderId)}`),
    buildLeg: (orderId, legId) => request('POST', leg(orderId, legId, 'build')),
    reportLeg: (orderId, legId, body) => request('POST', leg(orderId, legId, 'report'), body),
    cancelLeg: (orderId, legId) => request('POST', leg(orderId, legId, 'cancel')),
  };
}
