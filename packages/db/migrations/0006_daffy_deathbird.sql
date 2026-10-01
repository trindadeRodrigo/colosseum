CREATE TABLE "risk_lending_pools" (
	"account" text PRIMARY KEY NOT NULL,
	"chain" text NOT NULL,
	"venue" text NOT NULL,
	"program" text NOT NULL,
	"market" text NOT NULL,
	"market_name" text,
	"role" text NOT NULL,
	"mint" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"debt_mint" text,
	"debt_symbol" text,
	"dex_asset_mint" text,
	"accounts" jsonb NOT NULL,
	"oracles" jsonb NOT NULL,
	"params" jsonb NOT NULL,
	"manager" text,
	"offered" integer,
	"first_tx_at" timestamp with time zone,
	"verification" text NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"method_version" text NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"provenance" "provenance" NOT NULL
);
--> statement-breakpoint
CREATE INDEX "risk_lending_pools_market_idx" ON "risk_lending_pools" USING btree ("market");--> statement-breakpoint
CREATE INDEX "risk_lending_pools_dex_asset_idx" ON "risk_lending_pools" USING btree ("dex_asset_mint");