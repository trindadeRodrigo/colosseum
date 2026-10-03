CREATE TABLE "risk_depth_recovery" (
	"asset" text NOT NULL,
	"regime" text NOT NULL,
	"report_at" timestamp with time zone NOT NULL,
	"large_share" double precision NOT NULL,
	"trades" integer NOT NULL,
	"recovered" integer NOT NULL,
	"minutes_to_50" double precision,
	"minutes_to_90" double precision,
	"not_recovered_24h" double precision NOT NULL,
	"data_from" timestamp with time zone NOT NULL,
	"data_to" timestamp with time zone NOT NULL,
	"method_version" text NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"provenance" "provenance" NOT NULL,
	CONSTRAINT "risk_depth_recovery_pk" PRIMARY KEY("asset","regime","report_at","method_version")
);
