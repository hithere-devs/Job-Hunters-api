CREATE TABLE "application_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"portal" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempt_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apply_attempts" ADD COLUMN "submit_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "application_dispatches" ADD CONSTRAINT "application_dispatches_candidate_id_hunt_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."hunt_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_dispatches" ADD CONSTRAINT "application_dispatches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_dispatches" ADD CONSTRAINT "application_dispatches_run_id_hunt_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."hunt_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_flags" ADD CONSTRAINT "attempt_flags_attempt_id_apply_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."apply_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_flags" ADD CONSTRAINT "attempt_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_dispatches_pending_idx" ON "application_dispatches" USING btree ("delivered_at");--> statement-breakpoint
CREATE INDEX "application_dispatches_candidate_idx" ON "application_dispatches" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "attempt_flags_status_idx" ON "attempt_flags" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_token_hash_idx" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_reset_user_idx" ON "password_reset_tokens" USING btree ("user_id");