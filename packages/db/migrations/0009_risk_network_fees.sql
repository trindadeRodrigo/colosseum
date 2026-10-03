CREATE TABLE "risk_network_fees" (
	"signature" text PRIMARY KEY NOT NULL,
	"chain" text NOT NULL,
	"origin" text NOT NULL,
	"slot" double precision NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"fee_lamports" double precision NOT NULL,
	"compute_units" double precision,
	"sol_usd" double precision NOT NULL,
	"fee_usd" double precision NOT NULL,
	"method_version" text NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"provenance" "provenance" NOT NULL
);
