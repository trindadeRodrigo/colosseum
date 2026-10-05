CREATE TABLE "risk_market_params" (
	"venue" text NOT NULL,
	"market" text NOT NULL,
	"account" text NOT NULL,
	"asset_mint" text,
	"asset" text NOT NULL,
	"borrow_asset" text,
	"is_xstock" integer NOT NULL,
	"params" jsonb NOT NULL,
	"totals" jsonb,
	"verification" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"slot" double precision,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"provenance" "provenance" NOT NULL,
	CONSTRAINT "risk_market_params_account_fetched_at_pk" PRIMARY KEY("account","fetched_at")
);
