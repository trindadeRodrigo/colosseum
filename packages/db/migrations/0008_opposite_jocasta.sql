CREATE TABLE "risk_price_observations" (
	"chain" text NOT NULL,
	"mint" text NOT NULL,
	"price_source" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"slot" double precision NOT NULL,
	"price" double precision NOT NULL,
	"quote" text NOT NULL,
	"ref" text NOT NULL,
	"market" text,
	"live" boolean DEFAULT true NOT NULL,
	"source_ts" timestamp with time zone,
	"market_status" integer,
	"method_version" text NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"provenance" "provenance" NOT NULL,
	CONSTRAINT "risk_price_observations_pk" PRIMARY KEY("price_source","ref","mint","observed_at","slot","price")
);
--> statement-breakpoint
CREATE TABLE "risk_reference_prices" (
	"mint" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"chain" text NOT NULL,
	"symbol" text,
	"price_usd" double precision,
	"price_source" text,
	"ref" text,
	"quality" text,
	"regime" text NOT NULL,
	"age_sec" double precision,
	"price_observed_at" timestamp with time zone,
	"null_reason" text,
	"others" jsonb NOT NULL,
	"method_version" text NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"provenance" "provenance" NOT NULL,
	CONSTRAINT "risk_reference_prices_pk" PRIMARY KEY("mint","observed_at","method_version")
);
--> statement-breakpoint
CREATE INDEX "risk_price_observations_mint_idx" ON "risk_price_observations" USING btree ("mint","price_source","observed_at");