import type { McpHttpHandler } from '@modelcontextprotocol/server';

// For tests only: JSON-RPC over the server's HTTP face, as a client sends it with no session (the
// stateless 2025 form every client speaks, which the SDK serves beside 2026-07-28).

export type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
};

export type ListedTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, boolean>;
};

let next = 0;

/** One JSON-RPC request; the answer's `result`, or a thrown error with the JSON-RPC error. */
export async function rpc(
  mcp: McpHttpHandler,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<unknown> {
  next += 1;
  const res = await mcp.fetch(
    new Request('http://mcp.test/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: next, method, params }),
    }),
  );
  const text = await res.text();
  const data = text.startsWith('{')
    ? text
    : text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('');
  const message = JSON.parse(data) as { result?: unknown; error?: { message: string } };
  if (message.error) throw new Error(`${method}: ${message.error.message}`);
  return message.result;
}

export const listTools = async (mcp: McpHttpHandler) =>
  ((await rpc(mcp, 'tools/list')) as { tools: ListedTool[] }).tools;

export const callTool = async (
  mcp: McpHttpHandler,
  name: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) => (await rpc(mcp, 'tools/call', { name, arguments: args }, headers)) as ToolResult;

/** A failure's fields, from its text. */
export const failureOf = (result: ToolResult) =>
  JSON.parse(result.content[0]?.text ?? '{}') as {
    code: string;
    error: string;
    fix: string;
    [key: string]: unknown;
  };
