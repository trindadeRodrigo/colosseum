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
ALTER TABLE "proposals" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "plan_threads" ADD CONSTRAINT "plan_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_turns" ADD CONSTRAINT "plan_turns_thread_id_plan_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."plan_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_turns" ADD CONSTRAINT "plan_turns_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_turns_thread_seq_idx" ON "plan_turns" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "plan_turns_plan_idx" ON "plan_turns" USING btree ("proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_turns_event_once_idx" ON "plan_turns" USING btree ("thread_id","event_key");--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_thread_id_plan_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."plan_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposals_thread_idx" ON "proposals" USING btree ("thread_id");