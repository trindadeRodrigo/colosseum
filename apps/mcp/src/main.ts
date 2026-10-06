import { createServer } from 'node:http';
import { configOf, serveNode } from './http';
import { createTenonfiMcp } from './server';

// The MCP server's process: `pnpm --filter @colosseum/mcp start`. It reads its settings once, here, and
// holds no secret: the API's and the app's addresses, the port and the origins a browser may call from.
//
//   TENONFI_API_URL      the API (default https://tenonfi-api.onrender.com)
//   TENONFI_APP_URL      the app, where the links a person opens point (default http://localhost:3000)
//   PORT, HOST           where to listen (default 8787 on 0.0.0.0; the host sets PORT)
//   MCP_ALLOWED_ORIGINS  browser origins allowed to call /mcp, comma-separated (default none)

const config = configOf(process.env);
const mcp = createTenonfiMcp(config);
createServer(serveNode(mcp, config)).listen(config.port, config.host, () => {
  console.log(`tenonfi mcp on http://${config.host}:${config.port}/mcp, api ${config.apiUrl}`);
});
