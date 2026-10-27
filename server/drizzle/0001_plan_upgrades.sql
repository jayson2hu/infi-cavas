CREATE TABLE "plan_upgrade_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"from_plan" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "plan_upgrade_requests_status_check" CHECK ("plan_upgrade_requests"."status" IN ('pending','approved','rejected'))
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"monthly_credits" integer NOT NULL,
	"price_text" text,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_id_check" CHECK ("plans"."id" IN ('free','team','enterprise')),
	CONSTRAINT "plans_monthly_credits_check" CHECK ("plans"."monthly_credits" >= 0)
);
--> statement-breakpoint
ALTER TABLE "plan_upgrade_requests" ADD CONSTRAINT "plan_upgrade_requests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_upgrade_requests" ADD CONSTRAINT "plan_upgrade_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_upgrade_requests" ADD CONSTRAINT "plan_upgrade_requests_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_upgrade_requests" ADD CONSTRAINT "plan_upgrade_requests_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_upgrade_requests_pending_key" ON "plan_upgrade_requests" USING btree ("workspace_id") WHERE "plan_upgrade_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "plan_upgrade_requests_status_idx" ON "plan_upgrade_requests" USING btree ("status","created_at");