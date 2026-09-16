CREATE TABLE "user_browser_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"vm_id" text NOT NULL,
	"tenant_index" smallint NOT NULL,
	"status" text DEFAULT 'absent' NOT NULL,
	"cookie_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_browser_sessions_tenant_index_check" CHECK ("user_browser_sessions"."tenant_index" between 1 and 10)
);
--> statement-breakpoint
ALTER TABLE "user_browser_sessions" ADD CONSTRAINT "user_browser_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_browser_sessions_user_idx" ON "user_browser_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_browser_sessions_slot_idx" ON "user_browser_sessions" USING btree ("vm_id","tenant_index");
--> statement-breakpoint
DROP INDEX IF EXISTS field_answers_scope_idx;
CREATE UNIQUE INDEX field_answers_scope_idx ON field_answers (user_id, host, field_signature) NULLS NOT DISTINCT;
