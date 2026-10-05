CREATE TABLE "risk_asset_snapshots" (
	"asset_mint" text NOT NULL,
	"asset" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"slot" double precision,
	"ref_pool" text NOT NULL,
	"ref_mid_usd" double precision NOT NULL,
	"pools" integer NOT NULL,
	"sell" jsonb NOT NULL,
	"buy" jsonb NOT NULL,
	"method_version" text NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"provenance" "provenance" NOT NULL,
	CONSTRAINT "risk_asset_snapshots_asset_mint_fetched_at_pk" PRIMARY KEY("asset_mint","fetched_at")
);
