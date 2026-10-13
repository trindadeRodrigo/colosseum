ALTER TABLE "risk_pool_flow" ADD COLUMN IF NOT EXISTS "venue" text;--> statement-breakpoint
ALTER TABLE "risk_pool_flow" ADD COLUMN IF NOT EXISTS "quote_symbol" text;--> statement-breakpoint
ALTER TABLE "risk_pool_flow" ADD COLUMN IF NOT EXISTS "quote_mint" text;--> statement-breakpoint
-- PLAN-UNIVERSE RU.14: the rows written before this carry the venue and the quote risk_pools knows (Solana);
-- the EVM rows, which have no risk_pools row, are written again by pnpm risk-evm:flow-import.
-- IF NOT EXISTS: a database that ran this change as 0013 on the branch keeps its columns.
UPDATE "risk_pool_flow" f SET "venue" = p."venue", "quote_symbol" = p."quote_symbol", "quote_mint" = p."quote_mint"
FROM "risk_pools" p WHERE p."address" = f."pool" AND f."venue" IS NULL;
