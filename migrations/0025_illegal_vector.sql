CREATE TABLE "pending_application_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"host" text NOT NULL,
	"field_signature" text NOT NULL,
	"field_name" text,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" text,
	"remember" boolean DEFAULT false NOT NULL,
	"blocked_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "field_answers" ADD COLUMN "provenance" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_application_questions" ADD CONSTRAINT "pending_application_questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_application_questions" ADD CONSTRAINT "pending_application_questions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_application_questions" ADD CONSTRAINT "pending_application_questions_attempt_id_apply_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."apply_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_questions_attempt_field_idx" ON "pending_application_questions" USING btree ("attempt_id","field_signature");--> statement-breakpoint
CREATE INDEX "pending_questions_user_status_idx" ON "pending_application_questions" USING btree ("user_id","status");