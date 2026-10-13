ALTER TABLE "orders" ADD COLUMN "basket_id" text;--> statement-breakpoint
CREATE INDEX "proposals_from_link_created_idx" ON "proposals" USING btree ("created_at") WHERE "proposals"."from_link";