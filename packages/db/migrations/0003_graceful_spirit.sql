CREATE TABLE "risk_depth_curves" (
	"asset_mint" text NOT NULL,
	"asset_symbol" text NOT NULL,
	"side" text NOT NULL,
	"regime" text NOT NULL,
	"points" jsonb NOT NULL,
	"insufficient_from" integer,
	"quantile" double precision NOT NULL,
	"min_samples" integer NOT NULL,
	"samples" integer NOT NULL,
	"data_from" timestamp with time zone,
	"data_to" timestamp with time zone,
	"computed_at" timestamp with time zone NOT NULL,
	"method_version" text NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"provenance" "provenance" NOT NULL,
	CONSTRAINT "risk_depth_curves_asset_mint_side_regime_method_version_pk" PRIMARY KEY("asset_mint","side","regime","method_version")
);
--> statement-breakpoint
CREATE TABLE "risk_events" (
	"pool" text NOT NULL,
	"kind" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"slot" double precision,
	"asset" text,
	"detail" jsonb NOT NULL,
	CONSTRAINT "risk_events_pool_kind_fetched_at_pk" PRIMARY KEY("pool","kind","fetched_at")
);
--> statement-breakpoint
CREATE TABLE "risk_lp_concentration" (
	"pool" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"asset" text NOT NULL,
	"positions" integer NOT NULL,
	"in_band_positions" integer NOT NULL,
	"top1" double precision NOT NULL,
	"top3" double precision NOT NULL,
	"top10" double precision NOT NULL,
	"holder_kind" text NOT NULL,
	"band_pct" double precision NOT NULL,
	"lp_exit_n" integer NOT NULL,
	"sell_base" jsonb,
	"sell_without_top_n" jsonb,
	"method_version" text NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"provenance" "provenance" NOT NULL,
	CONSTRAINT "risk_lp_concentration_pool_fetched_at_pk" PRIMARY KEY("pool","fetched_at")
);
--> statement-breakpoint
CREATE TABLE "risk_quotes" (
	"run_id" text NOT NULL,
	"asset_mint" text NOT NULL,
	"asset" text NOT NULL,
	"side" text NOT NULL,
	"notional_usd" double precision NOT NULL,
	"amount_in" text,
	"out_amount" text,
	"route" jsonb,
	"error" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"source" text,
	"method" text,
	"provenance" "provenance" NOT NULL,
	CONSTRAINT "risk_quotes_run_id_asset_mint_side_notional_usd_pk" PRIMARY KEY("run_id","asset_mint","side","notional_usd")
);
