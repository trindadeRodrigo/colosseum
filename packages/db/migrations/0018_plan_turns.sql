CREATE TABLE "plan_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "plan_turns_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"proposal_id" uuid NOT NULL,
	"who" text NOT NULL,
	"text" text,
	"reply" jsonb,
	"event" jsonb,
	"event_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_turns" ADD CONSTRAINT "plan_turns_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_turns_plan_seq_idx" ON "plan_turns" USING btree ("proposal_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_turns_event_once_idx" ON "plan_turns" USING btree ("proposal_id","event_key");