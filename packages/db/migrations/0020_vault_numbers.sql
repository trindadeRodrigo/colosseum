CREATE TABLE "vault_numbers" (
	"user_id" uuid NOT NULL,
	"chain_id" text NOT NULL,
	"address" text NOT NULL,
	"number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_numbers_user_id_chain_id_address_pk" PRIMARY KEY("user_id","chain_id","address"),
	CONSTRAINT "vault_numbers_user_number_key" UNIQUE("user_id","number"),
	CONSTRAINT "vault_numbers_number_positive" CHECK ("vault_numbers"."number" > 0)
);
--> statement-breakpoint
ALTER TABLE "vault_numbers" ADD CONSTRAINT "vault_numbers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_numbers" ADD CONSTRAINT "vault_numbers_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;