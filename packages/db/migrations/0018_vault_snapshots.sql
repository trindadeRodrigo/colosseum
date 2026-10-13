CREATE TABLE "snapshot_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"vaults_read" integer DEFAULT 0 NOT NULL,
	"vaults_failed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"provenance" "provenance" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" text NOT NULL,
	"address" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"block_or_slot" numeric(20, 0),
	"owner" text NOT NULL,
	"basket_id" uuid,
	"onchain_basket_id" numeric(20, 0) NOT NULL,
	"recipe_onchain_id" text,
	"accepted_version" integer NOT NULL,
	"auto_follow" boolean NOT NULL,
	"value_usd" numeric(18, 2) NOT NULL,
	"cash" jsonb NOT NULL,
	"positions" jsonb NOT NULL,
	"pending" jsonb,
	"loss_used_bps" integer NOT NULL,
	"band_bps" integer,
	"loss_cap_bps" integer,
	"paused" boolean,
	"prices" jsonb NOT NULL,
	"provenance" "provenance" NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	CONSTRAINT "vault_snapshots_chain_address_time_key" UNIQUE("chain_id","address","observed_at")
);
--> statement-breakpoint
ALTER TABLE "snapshot_runs" ADD CONSTRAINT "snapshot_runs_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_snapshots" ADD CONSTRAINT "vault_snapshots_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_snapshots" ADD CONSTRAINT "vault_snapshots_basket_id_baskets_id_fk" FOREIGN KEY ("basket_id") REFERENCES "public"."baskets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_runs_one_open_per_chain" ON "snapshot_runs" USING btree ("chain_id") WHERE "snapshot_runs"."finished_at" is null;--> statement-breakpoint
CREATE INDEX "snapshot_runs_chain_started_idx" ON "snapshot_runs" USING btree ("chain_id","started_at");--> statement-breakpoint
CREATE INDEX "vault_snapshots_owner_time_idx" ON "vault_snapshots" USING btree ("owner","observed_at");