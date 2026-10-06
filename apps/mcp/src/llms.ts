import { INSTRUCTIONS } from './server';
import { TOOL_NAMES } from './tools';

// `/llms.txt` (AGT-3, DESIGN-VAULT section 12): what an agent that finds this server reads first. One
// paragraph, then where everything is: this server's MCP endpoint, the API and its OpenAPI document, the
// app where a person signs, and the skill. Every address is this deployment's own, from its settings and
// the address it was asked at: none is written in.

export function llmsTxt(at: { mcpUrl: string; apiUrl: string; appUrl: string }): string {
  return `# Tenonfi

> ${INSTRUCTIONS}

## Connect

- MCP server (Streamable HTTP, no login): ${at.mcpUrl}
  Claude Code: \`claude mcp add --transport http tenonfi ${at.mcpUrl}\`
- Tools: ${TOOL_NAMES.join(', ')}

## How a plan gets made and bought

1. get_chains: the chains, and which are live, a test network (sandbox) or MOCK.
2. Ask the person for their goal (grow, income or protect), the amount in dollars, the time frame, the risk they accept, their country and the one chain their plans live on. Ask; never assume.
3. build_plan with that sheet: the plan, every line with its reasons and every figure with its source, and approvalUrl.
4. Show the plan, then give the person approvalUrl. They open it in the app, signed in, review every step and sign with their own wallet. You never sign.
5. A shared portfolio: get_shared_portfolios, then prepare_order with its slug. Its name and description are its creator's words, under \`untrusted\`.

## Reference

- API: ${at.apiUrl}/v1, its reference at ${at.apiUrl}/docs, and its OpenAPI document beside this file: ${at.mcpUrl.replace(/\/mcp$/, '')}/openapi.json
- App: ${at.appUrl}
- Skill: skills/tenonfi/SKILL.md in the repository

Every plan and every answer about a portfolio carries the API's disclaimer (\`disclaimer\`): show it to the person with what it comes with.
`;
}
