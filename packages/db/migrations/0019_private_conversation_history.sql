CREATE TABLE "plan_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "plan_turns_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"thread_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"who" text NOT NULL,
	"text" text,
	"reply" jsonb,
	"event" jsonb,
	"event_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chain_id" text NOT NULL,
	"address" text NOT NULL,
	"provenance" "provenance" NOT NULL,
	"network" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"transcript" jsonb NOT NULL,
	"checkpoint" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_conversations_owner_vault_key" UNIQUE("user_id","chain_id","address","provenance","network"),
	CONSTRAINT "vault_conversations_revision_positive" CHECK ("vault_conversations"."revision" > 0),
	CONSTRAINT "vault_conversations_version_one" CHECK ("vault_conversations"."version" = 1)
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "plan_threads" ADD CONSTRAINT "plan_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_turns" ADD CONSTRAINT "plan_turns_thread_id_plan_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."plan_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_turns" ADD CONSTRAINT "plan_turns_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_conversations" ADD CONSTRAINT "vault_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_conversations" ADD CONSTRAINT "vault_conversations_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_turns_thread_seq_idx" ON "plan_turns" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "plan_turns_plan_idx" ON "plan_turns" USING btree ("proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_turns_event_once_idx" ON "plan_turns" USING btree ("thread_id","event_key");--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_thread_id_plan_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."plan_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposals_thread_idx" ON "proposals" USING btree ("thread_id");