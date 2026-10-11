ALTER TABLE "apply_attempts" ADD COLUMN IF NOT EXISTS "submit_outcome" text;--> statement-breakpoint
ALTER TABLE "apply_attempts" ADD COLUMN IF NOT EXISTS "failure_class" text;--> statement-breakpoint
ALTER TABLE "apply_attempts" ADD COLUMN IF NOT EXISTS "retry_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "apply_attempts" ADD COLUMN IF NOT EXISTS "schema_source" text;--> statement-breakpoint
ALTER TABLE "apply_attempts" ADD COLUMN IF NOT EXISTS "answer_plan" jsonb;--> statement-breakpoint
ALTER TABLE "apply_attempts" ADD COLUMN IF NOT EXISTS "runner_version" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apply_attempts_failure_idx" ON "apply_attempts" USING btree ("failure_class","created_at");--> statement-breakpoint
ALTER TABLE "application_dispatches" ADD COLUMN IF NOT EXISTS "not_before" timestamp with time zone;--> statement-breakpoint
-- Backfill: 409 deferrals were recorded as failed attempts although nothing ran.
UPDATE "apply_attempts" SET "failure_class" = 'deferred' WHERE "failure_class" IS NULL AND "error" = 'Browser is busy; deferred before opening application.';--> statement-breakpoint
UPDATE "apply_attempts" SET "submit_outcome" = 'confirmed' WHERE "submit_outcome" IS NULL AND "status" = 'submitted';--> statement-breakpoint
UPDATE "apply_attempts" SET "submit_outcome" = 'uncertain', "failure_class" = 'uncertain_submit' WHERE "submit_outcome" IS NULL AND "status" = 'unknown' AND "submit_started_at" IS NOT NULL;
