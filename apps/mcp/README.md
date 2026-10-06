# apps/mcp

Tenonfi's MCP server (AGT-2, `docs/vault/DESIGN-VAULT.md` section 12): seven tools on the API, over stateless Streamable HTTP at `/mcp`, with no login. It reaches the API only through `@colosseum/sdk`'s client, and the tools' schemas are cut from the API's OpenAPI document (`packages/sdk/openapi.json`).

It never signs. `build_plan` and `prepare_order` answer a link; the person opens it in the app, signed in, reviews every step and signs with their own wallet. A client that holds a person's sign-in may send it in the two headers the API reads (`Authorization: Bearer` and `privy-id-token`); those two are passed to the API as they came, and nothing else of the request.

| Path | What |
|---|---|
| `/mcp` | the MCP server |
| `/llms.txt` | what an agent reads first, with this deployment's addresses |
| `/openapi.json` | the API's `/v1` document |
| `/health` | `{ "ok": true }` |

## Run

```
pnpm --filter @colosseum/mcp start
```

| Variable | What | Default |
|---|---|---|
| `TENONFI_API_URL` | the API | `https://tenonfi-api.onrender.com` |
| `TENONFI_APP_URL` | the app, where links point | required, but for a server on `HOST=127.0.0.1` (then `http://localhost:3000`) |
| `PORT`, `HOST` | where to listen | `8787`, `0.0.0.0` |
| `MCP_ALLOWED_ORIGINS` | browser origins allowed to call `/mcp`, comma-separated | none |

It holds no secret. Every call stays on the API's origin and follows no redirect. The API counts every agent behind one MCP server as one anonymous caller, so they share its budget. `build_plan` needs the API's agent surface on (`AGENT_SURFACE=on` on the API): off, the API answers 404 and the tool says so.

## Host on Render

A web service from this repository: build command `corepack enable && pnpm install --frozen-lockfile`, start command `pnpm --filter @colosseum/mcp start`, health check path `/health`. Render sets `PORT`. Set `TENONFI_APP_URL` to the hosted app. Deploying needs a person's word.

## Tests

`src/tools.test.ts` (the tools against a double of the API, the sign-in passed on and nothing else, no route that builds, signs or places an order), `src/http.test.ts` (settings, paths, a browser origin refused), and `tests/mcp-contract.test.ts` at the root (every tool against the real API in-process, each request and answer held to the OpenAPI document).
