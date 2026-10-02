# Scripts that can send a mainnet transaction

Everything that can spend real money from a script lives in this folder, so it is easy to see and easy to guard. A person runs these, never an agent.

- `sign-and-send.ts`: signs and sends the transactions of a plan from the demo wallet. Dry run by default; `--send` sends. Run it as `pnpm sign-and-send --plan <id>`.
