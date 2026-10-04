ALTER TABLE "legs" ADD COLUMN "cash_raw" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "chain_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "chain_picked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;