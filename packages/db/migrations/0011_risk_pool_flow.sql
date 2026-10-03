CREATE TABLE "risk_pool_flow" (
	"pool" text NOT NULL,
	"asset_mint" text NOT NULL,
	"asset_symbol" text NOT NULL,
	"regime" text NOT NULL,
	"window" text NOT NULL,
	"swaps" integer NOT NULL,
	"sell_swaps" integer NOT NULL,
	"buy_swaps" integer NOT NULL,
	"unpriced_swaps" integer NOT NULL,
	"sell_usd" double precision NOT NULL,
	"buy_usd" double precision NOT NULL,
	"hours" integer NOT NULL,
	"median_depth_sell_usd" double precision,
	"data_from" timestamp with time zone NOT NULL,
	"data_to" timestamp with time zone NOT NULL,
	"method_version" text NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"provenance" "provenance" NOT NULL,
	CONSTRAINT "risk_pool_flow_pk" PRIMARY KEY("pool","regime","window","data_to")
);
--> statement-breakpoint
CREATE INDEX "risk_pool_flow_asset_idx" ON "risk_pool_flow" USING btree ("asset_mint","data_to");