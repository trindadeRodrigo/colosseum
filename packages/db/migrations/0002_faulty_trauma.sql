CREATE TABLE "risk_pool_snapshots" (
	"pool" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"slot" double precision,
	"mid_price" double precision NOT NULL,
	"active_liquidity" text,
	"sell" jsonb NOT NULL,
	"buy" jsonb NOT NULL,
	"in_band_liquidity" double precision,
	"method_version" text NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"provenance" "provenance" NOT NULL,
	CONSTRAINT "risk_pool_snapshots_pool_fetched_at_pk" PRIMARY KEY("pool","fetched_at")
);
--> statement-breakpoint
CREATE TABLE "risk_pools" (
	"address" text PRIMARY KEY NOT NULL,
	"program" text NOT NULL,
	"venue" text NOT NULL,
	"asset_mint" text NOT NULL,
	"asset_symbol" text NOT NULL,
	"quote_mint" text NOT NULL,
	"quote_symbol" text,
	"exit_path" text NOT NULL,
	"asset_is_token0" integer NOT NULL,
	"decimals0" integer NOT NULL,
	"decimals1" integer NOT NULL,
	"transfer_fee_bps0" integer DEFAULT 0 NOT NULL,
	"transfer_fee_bps1" integer DEFAULT 0 NOT NULL,
	"tvl_usd" double precision,
	"discovery_liquidity_usd" double precision,
	"discovery_volume24h_usd" double precision,
	"tier" text NOT NULL,
	"status" text NOT NULL,
	"status_reason" text,
	"method_version" text NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"provenance" "provenance" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "risk_pool_snapshots" ADD CONSTRAINT "risk_pool_snapshots_pool_risk_pools_address_fk" FOREIGN KEY ("pool") REFERENCES "public"."risk_pools"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "risk_pools_asset_idx" ON "risk_pools" USING btree ("asset_mint");--> statement-breakpoint
CREATE INDEX "risk_pools_tier_idx" ON "risk_pools" USING btree ("tier");