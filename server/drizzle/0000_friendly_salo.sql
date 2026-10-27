CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"last4" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "brand_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"spec" text,
	"object_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer,
	"height" integer,
	"bytes" integer,
	"attach_on_generate" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_assets_kind_check" CHECK ("brand_assets"."kind" IN ('logo','sku','style_ref'))
);
--> statement-breakpoint
CREATE TABLE "brand_colors" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"hex" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "brand_colors_role_check" CHECK ("brand_colors"."role" IN ('primary','secondary','background','accent')),
	CONSTRAINT "brand_colors_hex_check" CHECK ("brand_colors"."hex" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"industry" text,
	"description" text,
	"required_terms" text[] DEFAULT '{}'::text[] NOT NULL,
	"avoid_terms" text[] DEFAULT '{}'::text[] NOT NULL,
	"default_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enforced" boolean DEFAULT false NOT NULL,
	"editor_user_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_buckets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"granted" integer NOT NULL,
	"remaining" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_buckets_kind_check" CHECK ("credit_buckets"."kind" IN ('subscription','purchase','gift')),
	CONSTRAINT "credit_buckets_granted_check" CHECK ("credit_buckets"."granted" >= 0),
	CONSTRAINT "credit_buckets_remaining_check" CHECK ("credit_buckets"."remaining" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"credits" integer NOT NULL,
	"bonus_credits" integer DEFAULT 0 NOT NULL,
	"price_cents" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"type" text NOT NULL,
	"amount" integer NOT NULL,
	"breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"job_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_transactions_type_check" CHECK ("credit_transactions"."type" IN ('grant','hold','settle','refund','expire','adjust'))
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"api_token_id" text,
	"model_id" text NOT NULL,
	"provider_id" text,
	"capability" text NOT NULL,
	"endpoint" text NOT NULL,
	"status" text NOT NULL,
	"estimate_credits" integer NOT NULL,
	"charged_credits" integer DEFAULT 0 NOT NULL,
	"hold_breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overdraft" boolean DEFAULT false NOT NULL,
	"brand_id" text,
	"project_id" text,
	"node_id" text,
	"source" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt" text,
	"usage" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "generation_jobs_capability_check" CHECK ("generation_jobs"."capability" IN ('image','video','text','audio')),
	CONSTRAINT "generation_jobs_status_check" CHECK ("generation_jobs"."status" IN ('held','succeeded','failed','timeout'))
);
--> statement-breakpoint
CREATE TABLE "generation_outputs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"kind" text NOT NULL,
	"object_key" text,
	"mime_type" text,
	"bytes" integer,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_outputs_kind_check" CHECK ("generation_outputs"."kind" IN ('image','video','audio','text'))
);
--> statement-breakpoint
CREATE TABLE "model_routes" (
	"model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"upstream_model" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "model_routes_pkey" PRIMARY KEY("model_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"capability" text NOT NULL,
	"supports_edit" boolean DEFAULT false NOT NULL,
	"max_reference_images" integer DEFAULT 8 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "models_capability_check" CHECK ("models"."capability" IN ('image','video','text','audio'))
);
--> statement-breakpoint
CREATE TABLE "payment_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"package_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"provider_ref" text,
	"raw_notify" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "payment_orders_status_check" CHECK ("payment_orders"."status" IN ('pending','paid','closed','refunded'))
);
--> statement-breakpoint
CREATE TABLE "pricing_rules" (
	"model_id" text PRIMARY KEY NOT NULL,
	"unit" text NOT NULL,
	"config" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_rules_unit_check" CHECK ("pricing_rules"."unit" IN ('per_image','per_second','per_1k_tokens','per_1k_chars'))
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"api_format" text DEFAULT 'openai' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_api_format_check" CHECK ("providers"."api_format" IN ('openai'))
);
--> statement-breakpoint
CREATE TABLE "redeem_code_uses" (
	"code" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"bucket_id" text NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redeem_code_uses_pkey" PRIMARY KEY("code","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "redeem_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"credits" integer NOT NULL,
	"kind" text NOT NULL,
	"valid_days" integer,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redeem_codes_credits_check" CHECK ("redeem_codes"."credits" > 0),
	CONSTRAINT "redeem_codes_kind_check" CHECK ("redeem_codes"."kind" IN ('purchase','gift'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"cover_object_key" text,
	"preview_nodes" text[] DEFAULT '{}'::text[] NOT NULL,
	"body" jsonb NOT NULL,
	"estimate_credits" integer DEFAULT 0 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"is_published" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"last_workspace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_key" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "video_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"upstream_task_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"output_object_key" text,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_tasks_job_id_key" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_invites" (
	"token" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"role" text NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invites_role_check" CHECK ("workspace_invites"."role" IN ('admin','member'))
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"monthly_cap" integer,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_pkey" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_members_role_check" CHECK ("workspace_members"."role" IN ('owner','admin','member'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"plan_monthly_credits" integer DEFAULT 0 NOT NULL,
	"period_start" timestamp with time zone DEFAULT now() NOT NULL,
	"period_end" timestamp with time zone DEFAULT (now() + interval '1 month') NOT NULL,
	"default_brand_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_kind_check" CHECK ("workspaces"."kind" IN ('personal','team')),
	CONSTRAINT "workspaces_plan_check" CHECK ("workspaces"."plan" IN ('free','team','enterprise'))
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_colors" ADD CONSTRAINT "brand_colors_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_buckets" ADD CONSTRAINT "credit_buckets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_api_token_id_fkey" FOREIGN KEY ("api_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_outputs" ADD CONSTRAINT "generation_outputs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "public"."credit_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redeem_code_uses" ADD CONSTRAINT "redeem_code_uses_code_fkey" FOREIGN KEY ("code") REFERENCES "public"."redeem_codes"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redeem_code_uses" ADD CONSTRAINT "redeem_code_uses_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redeem_code_uses" ADD CONSTRAINT "redeem_code_uses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redeem_code_uses" ADD CONSTRAINT "redeem_code_uses_bucket_id_fkey" FOREIGN KEY ("bucket_id") REFERENCES "public"."credit_buckets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redeem_codes" ADD CONSTRAINT "redeem_codes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_tasks" ADD CONSTRAINT "video_tasks_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_tasks" ADD CONSTRAINT "video_tasks_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_assets_brand_kind_idx" ON "brand_assets" USING btree ("brand_id","kind");--> statement-breakpoint
CREATE INDEX "brands_ws_idx" ON "brands" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "credit_buckets_ws_idx" ON "credit_buckets" USING btree ("workspace_id") WHERE "credit_buckets"."remaining" > 0;--> statement-breakpoint
CREATE INDEX "credit_transactions_ws_created_idx" ON "credit_transactions" USING btree ("workspace_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "generation_jobs_ws_created_idx" ON "generation_jobs" USING btree ("workspace_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "generation_jobs_user_month_idx" ON "generation_jobs" USING btree ("workspace_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "generation_jobs_held_idx" ON "generation_jobs" USING btree ("created_at") WHERE "generation_jobs"."status" = 'held';--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "templates_ws_cat_idx" ON "templates" USING btree ("workspace_id","category");--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");