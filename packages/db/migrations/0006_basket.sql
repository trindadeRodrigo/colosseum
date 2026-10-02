CREATE TABLE "basket_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" text NOT NULL,
	"address" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"cls" text NOT NULL,
	"underlying" text NOT NULL,
	"issuer" text NOT NULL,
	"tier" text NOT NULL,
	"price_kind" text NOT NULL,
	"price_ref" text NOT NULL,
	"session" text NOT NULL,
	"auto_follow_eligible" boolean NOT NULL,
	"max_weight_bps" integer NOT NULL,
	"blocked_countries" jsonb NOT NULL,
	"sheet" text NOT NULL,
	"provenance" "provenance" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "basket_assets_chain_address_key" UNIQUE("chain_id","address")
);
--> statement-breakpoint
CREATE TABLE "baskets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"family_id" text,
	"proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chains" (
	"id" text PRIMARY KEY NOT NULL,
	"family" "chain" NOT NULL,
	"name" text NOT NULL,
	"network" text NOT NULL,
	"network_name" text NOT NULL,
	"evm_chain_id" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"address" text NOT NULL,
	"kind" text NOT NULL,
	"text_version" text NOT NULL,
	"legs_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" text NOT NULL,
	"prompt_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_user_family_key" UNIQUE("user_id","family_id")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"route" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "index_families" (
	"family_id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name_key" text NOT NULL,
	"name" text NOT NULL,
	"copy" text NOT NULL,
	"creator_user_id" uuid,
	"creator_kind" text NOT NULL,
	"kind" text NOT NULL,
	"platform" boolean DEFAULT false NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "index_families_slug_unique" UNIQUE("slug"),
	CONSTRAINT "index_families_name_key_unique" UNIQUE("name_key")
);
--> statement-breakpoint
CREATE TABLE "keeper_legs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keeper_run_id" uuid NOT NULL,
	"chain_id" text NOT NULL,
	"vault_address" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"trades" jsonb NOT NULL,
	"expected" jsonb,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"tx_id" text,
	"explorer_url" text,
	"valid_until" text,
	"error" jsonb,
	"trigger" text NOT NULL,
	"provenance" "provenance" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keeper_legs_vault_run_seq_key" UNIQUE("chain_id","vault_address","keeper_run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "keeper_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" jsonb
);
--> statement-breakpoint
CREATE TABLE "keeper_vaults" (
	"chain_id" text NOT NULL,
	"vault_address" text NOT NULL,
	"synced_version" integer DEFAULT 0 NOT NULL,
	"expired_attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keeper_vaults_chain_id_vault_address_pk" PRIMARY KEY("chain_id","vault_address")
);
--> statement-breakpoint
CREATE TABLE "leg_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leg_id" uuid,
	"keeper_leg_id" uuid,
	"chain_id" text NOT NULL,
	"n" integer NOT NULL,
	"message_hash" text NOT NULL,
	"nonce" bigint,
	"status" text NOT NULL,
	"tx_id" text,
	"explorer_url" text,
	"valid_until" text,
	"fee_amount" numeric(78, 0),
	"built_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"provenance" "provenance" NOT NULL,
	CONSTRAINT "leg_attempts_chain_tx_key" UNIQUE("chain_id","tx_id"),
	CONSTRAINT "leg_attempts_leg_n_key" UNIQUE("leg_id","n"),
	CONSTRAINT "leg_attempts_keeper_leg_n_key" UNIQUE("keeper_leg_id","n"),
	CONSTRAINT "leg_attempts_one_leg" CHECK (num_nonnulls("leg_attempts"."leg_id", "leg_attempts"."keeper_leg_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "legs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"chain_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"signer" text NOT NULL,
	"description" text NOT NULL,
	"trades" jsonb NOT NULL,
	"expected" jsonb,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"tx_id" text,
	"explorer_url" text,
	"valid_until" text,
	"error" jsonb,
	"trigger" text NOT NULL,
	"provenance" "provenance" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legs_order_chain_seq_key" UNIQUE("order_id","chain_id","seq")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"owner_solana" text,
	"owner_evm" text,
	"user_id" uuid,
	"org_id" text,
	"summary" text NOT NULL,
	"request" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"needs_consent" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prepared_by" text NOT NULL,
	"agent_label" text,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"disclaimer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" text NOT NULL,
	"usd_per_token" numeric(38, 18) NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"provenance" "provenance" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inputs_hash" text NOT NULL,
	"user_id" uuid,
	"proposal" jsonb NOT NULL,
	"engine_version" text NOT NULL,
	"shelf_version" text NOT NULL,
	"params_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_inputs_hash_unique" UNIQUE("inputs_hash")
);
--> statement-breakpoint
CREATE TABLE "recipe_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipe_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"components" jsonb NOT NULL,
	"meta_hash" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"fee_bps" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_versions_recipe_version_key" UNIQUE("recipe_id","version")
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" text NOT NULL,
	"chain_id" text NOT NULL,
	"onchain_id" text,
	"creator" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipes_family_chain_key" UNIQUE("family_id","chain_id"),
	CONSTRAINT "recipes_chain_onchain_key" UNIQUE("chain_id","onchain_id")
);
--> statement-breakpoint
CREATE TABLE "user_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family" "chain" NOT NULL,
	"address" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_wallets_family_address_key" UNIQUE("family","address")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privy_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_privy_id_unique" UNIQUE("privy_id")
);
--> statement-breakpoint
CREATE TABLE "vaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" text NOT NULL,
	"address" text NOT NULL,
	"owner" text NOT NULL,
	"basket_id" uuid,
	"onchain_basket_id" numeric(20, 0) NOT NULL,
	"recipe_id" uuid,
	"accepted_version" integer DEFAULT 0 NOT NULL,
	"auto_follow" boolean DEFAULT false NOT NULL,
	"targets" jsonb NOT NULL,
	"balances" jsonb NOT NULL,
	"value_usd" numeric(18, 2),
	"vault_type" text DEFAULT 'standard' NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"provenance" "provenance" NOT NULL,
	CONSTRAINT "vaults_chain_address_key" UNIQUE("chain_id","address")
);
--> statement-breakpoint
ALTER TABLE "basket_assets" ADD CONSTRAINT "basket_assets_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baskets" ADD CONSTRAINT "baskets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baskets" ADD CONSTRAINT "baskets_family_id_index_families_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."index_families"("family_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baskets" ADD CONSTRAINT "baskets_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_family_id_index_families_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."index_families"("family_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "index_families" ADD CONSTRAINT "index_families_creator_user_id_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keeper_legs" ADD CONSTRAINT "keeper_legs_keeper_run_id_keeper_runs_id_fk" FOREIGN KEY ("keeper_run_id") REFERENCES "public"."keeper_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keeper_legs" ADD CONSTRAINT "keeper_legs_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keeper_runs" ADD CONSTRAINT "keeper_runs_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keeper_vaults" ADD CONSTRAINT "keeper_vaults_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leg_attempts" ADD CONSTRAINT "leg_attempts_leg_id_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."legs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leg_attempts" ADD CONSTRAINT "leg_attempts_keeper_leg_id_keeper_legs_id_fk" FOREIGN KEY ("keeper_leg_id") REFERENCES "public"."keeper_legs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leg_attempts" ADD CONSTRAINT "leg_attempts_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_observations" ADD CONSTRAINT "price_observations_asset_id_basket_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."basket_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_family_id_index_families_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."index_families"("family_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_basket_id_baskets_id_fk" FOREIGN KEY ("basket_id") REFERENCES "public"."baskets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "baskets_user_idx" ON "baskets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "consents_order_idx" ON "consents" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "follows_family_idx" ON "follows" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "keeper_legs_run_idx" ON "keeper_legs" USING btree ("keeper_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "keeper_runs_one_open_per_chain" ON "keeper_runs" USING btree ("chain_id") WHERE "keeper_runs"."finished_at" is null;--> statement-breakpoint
CREATE INDEX "leg_attempts_message_hash_idx" ON "leg_attempts" USING btree ("message_hash");--> statement-breakpoint
CREATE INDEX "orders_owner_solana_idx" ON "orders" USING btree ("owner_solana");--> statement-breakpoint
CREATE INDEX "orders_owner_evm_idx" ON "orders" USING btree ("owner_evm");--> statement-breakpoint
CREATE INDEX "price_observations_asset_time_idx" ON "price_observations" USING btree ("asset_id","fetched_at");--> statement-breakpoint
CREATE INDEX "user_wallets_user_idx" ON "user_wallets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "vaults_owner_idx" ON "vaults" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "vaults_recipe_idx" ON "vaults" USING btree ("recipe_id");