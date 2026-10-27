import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// 与 specs/schema.sql 保持一致；这里不添加应用层才有的验证或默认值。
const time = (name: string) => timestamp(name, { withTimezone: true });
export type CreditBreakdown = { bucketId: string; amount: number }[];

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique("users_email_key"),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  lastWorkspaceId: text("last_workspace_id"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique("sessions_token_hash_key"),
  userAgent: text("user_agent"),
  ip: text("ip"),
  expiresAt: time("expires_at").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "sessions_user_id_fkey", columns: [t.userId], foreignColumns: [users.id] }).onDelete("cascade"),
  index("sessions_user_idx").on(t.userId),
]);

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["personal", "team"] }).notNull(),
  ownerId: text("owner_id").notNull(),
  plan: text("plan", { enum: ["free", "team", "enterprise"] }).notNull().default("free"),
  planMonthlyCredits: integer("plan_monthly_credits").notNull().default(0),
  periodStart: time("period_start").notNull().defaultNow(),
  periodEnd: time("period_end").notNull().default(sql`(now() + interval '1 month')`),
  defaultBrandId: text("default_brand_id"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "workspaces_owner_id_fkey", columns: [t.ownerId], foreignColumns: [users.id] }),
  check("workspaces_kind_check", sql`${t.kind} IN ('personal','team')`),
  check("workspaces_plan_check", sql`${t.plan} IN ('free','team','enterprise')`),
]);

export const workspaceMembers = pgTable("workspace_members", {
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
  monthlyCap: integer("monthly_cap"),
  joinedAt: time("joined_at").notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: "workspace_members_pkey", columns: [t.workspaceId, t.userId] }),
  foreignKey({ name: "workspace_members_workspace_id_fkey", columns: [t.workspaceId], foreignColumns: [workspaces.id] }).onDelete("cascade"),
  foreignKey({ name: "workspace_members_user_id_fkey", columns: [t.userId], foreignColumns: [users.id] }).onDelete("cascade"),
  check("workspace_members_role_check", sql`${t.role} IN ('owner','admin','member')`),
  index("workspace_members_user_idx").on(t.userId),
]);

export const workspaceInvites = pgTable("workspace_invites", {
  token: text("token").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  role: text("role", { enum: ["admin", "member"] }).notNull(),
  createdBy: text("created_by").notNull(),
  expiresAt: time("expires_at").notNull(),
  acceptedBy: text("accepted_by"),
  acceptedAt: time("accepted_at"),
  createdAt: time("created_at").notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "workspace_invites_workspace_id_fkey", columns: [t.workspaceId], foreignColumns: [workspaces.id] }).onDelete("cascade"),
  foreignKey({ name: "workspace_invites_created_by_fkey", columns: [t.createdBy], foreignColumns: [users.id] }),
  foreignKey({ name: "workspace_invites_accepted_by_fkey", columns: [t.acceptedBy], foreignColumns: [users.id] }),
  check("workspace_invites_role_check", sql`${t.role} IN ('admin','member')`),
]);

export const apiTokens = pgTable("api_tokens", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique("api_tokens_token_hash_key"),
  last4: text("last4").notNull(),
  lastUsedAt: time("last_used_at"),
  revokedAt: time("revoked_at"),
  createdAt: time("created_at").notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "api_tokens_workspace_id_fkey", columns: [t.workspaceId], foreignColumns: [workspaces.id] }).onDelete("cascade"),
  foreignKey({ name: "api_tokens_user_id_fkey", columns: [t.userId], foreignColumns: [users.id] }).onDelete("cascade"),
]);

export const providers = pgTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKeyEncrypted: text("api_key_encrypted").notNull(),
  apiFormat: text("api_format", { enum: ["openai"] }).notNull().default("openai"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: time("created_at").notNull().defaultNow(),
}, (t) => [
  check("providers_api_format_check", sql`${t.apiFormat} IN ('openai')`),
]);

export const models = pgTable("models", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  capability: text("capability", { enum: ["image", "video", "text", "audio"] }).notNull(),
  supportsEdit: boolean("supports_edit").notNull().default(false),
  maxReferenceImages: integer("max_reference_images").notNull().default(8),
  isActive: boolean("is_active").notNull().default(true),
  sort: integer("sort").notNull().default(0),
  createdAt: time("created_at").notNull().defaultNow(),
}, (t) => [
  check("models_capability_check", sql`${t.capability} IN ('image','video','text','audio')`),
]);

export const modelRoutes = pgTable("model_routes", {
  modelId: text("model_id").notNull(),
  providerId: text("provider_id").notNull(),
  upstreamModel: text("upstream_model").notNull(),
  priority: integer("priority").notNull().default(0),
}, (t) => [
  primaryKey({ name: "model_routes_pkey", columns: [t.modelId, t.providerId] }),
  foreignKey({ name: "model_routes_model_id_fkey", columns: [t.modelId], foreignColumns: [models.id] }).onDelete("cascade"),
  foreignKey({ name: "model_routes_provider_id_fkey", columns: [t.providerId], foreignColumns: [providers.id] }).onDelete("cascade"),
]);

export const pricingRules = pgTable("pricing_rules", {
  modelId: text("model_id").primaryKey(),
  unit: text("unit", { enum: ["per_image", "per_second", "per_1k_tokens", "per_1k_chars"] }).notNull(),
  config: jsonb("config").$type<Record<string, number>>().notNull(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "pricing_rules_model_id_fkey", columns: [t.modelId], foreignColumns: [models.id] }).onDelete("cascade"),
  check("pricing_rules_unit_check", sql`${t.unit} IN ('per_image','per_second','per_1k_tokens','per_1k_chars')`),
]);

export const creditBuckets = pgTable("credit_buckets", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  kind: text("kind", { enum: ["subscription", "purchase", "gift"] }).notNull(),
  granted: integer("granted").notNull(),
  remaining: integer("remaining").notNull(),
  expiresAt: time("expires_at"),
  source: text("source").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "credit_buckets_workspace_id_fkey", columns: [t.workspaceId], foreignColumns: [workspaces.id] }).onDelete("cascade"),
  check("credit_buckets_kind_check", sql`${t.kind} IN ('subscription','purchase','gift')`),
  check("credit_buckets_granted_check", sql`${t.granted} >= 0`),
  check("credit_buckets_remaining_check", sql`${t.remaining} >= 0`),
  index("credit_buckets_ws_idx").on(t.workspaceId).where(sql`${t.remaining} > 0`),
]);

export const generationJobs = pgTable("generation_jobs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id").notNull(),
  apiTokenId: text("api_token_id"),
  modelId: text("model_id").notNull(),
  providerId: text("provider_id"),
  capability: text("capability", { enum: ["image", "video", "text", "audio"] }).notNull(),
  endpoint: text("endpoint").notNull(),
  status: text("status", { enum: ["held", "succeeded", "failed", "timeout"] }).notNull(),
  estimateCredits: integer("estimate_credits").notNull(),
  chargedCredits: integer("charged_credits").notNull().default(0),
  holdBreakdown: jsonb("hold_breakdown").$type<CreditBreakdown>().notNull().default(sql`'[]'::jsonb`),
  overdraft: boolean("overdraft").notNull().default(false),
  brandId: text("brand_id"),
  projectId: text("project_id"),
  nodeId: text("node_id"),
  source: text("source"),
  params: jsonb("params").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  prompt: text("prompt"),
  usage: jsonb("usage").$type<Record<string, unknown>>(),
  error: text("error"),
  createdAt: time("created_at").notNull().defaultNow(),
  finishedAt: time("finished_at"),
}, (t) => [
  foreignKey({ name: "generation_jobs_workspace_id_fkey", columns: [t.workspaceId], foreignColumns: [workspaces.id] }).onDelete("cascade"),
  foreignKey({ name: "generation_jobs_user_id_fkey", columns: [t.userId], foreignColumns: [users.id] }),
  foreignKey({ name: "generation_jobs_api_token_id_fkey", columns: [t.apiTokenId], foreignColumns: [apiTokens.id] }),
  foreignKey({ name: "generation_jobs_model_id_fkey", columns: [t.modelId], foreignColumns: [models.id] }),
  foreignKey({ name: "generation_jobs_provider_id_fkey", columns: [t.providerId], foreignColumns: [providers.id] }),
  check("generation_jobs_capability_check", sql`${t.capability} IN ('image','video','text','audio')`),
  check("generation_jobs_status_check", sql`${t.status} IN ('held','succeeded','failed','timeout')`),
  index("generation_jobs_ws_created_idx").on(t.workspaceId, t.createdAt.desc().nullsFirst()),
  index("generation_jobs_user_month_idx").on(t.workspaceId, t.userId, t.createdAt),
  index("generation_jobs_held_idx").on(t.createdAt).where(sql`${t.status} = 'held'`),
]);

export const creditTransactions = pgTable("credit_transactions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id"),
  type: text("type", { enum: ["grant", "hold", "settle", "refund", "expire", "adjust"] }).notNull(),
  amount: integer("amount").notNull(),
  breakdown: jsonb("breakdown").$type<CreditBreakdown>().notNull().default(sql`'[]'::jsonb`),
  jobId: text("job_id"),
  note: text("note"),
  createdAt: time("created_at").notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "credit_transactions_workspace_id_fkey", columns: [t.workspaceId], foreignColumns: [workspaces.id] }).onDelete("cascade"),
  foreignKey({ name: "credit_transactions_user_id_fkey", columns: [t.userId], foreignColumns: [users.id] }),
  foreignKey({ name: "credit_transactions_job_id_fkey", columns: [t.jobId], foreignColumns: [generationJobs.id] }),
  check("credit_transactions_type_check", sql`${t.type} IN ('grant','hold','settle','refund','expire','adjust')`),
  index("credit_transactions_ws_created_idx").on(t.workspaceId, t.createdAt.desc().nullsFirst()),
]);

export const generationOutputs = pgTable("generation_outputs", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  kind: text("kind", { enum: ["image", "video", "audio", "text"] }).notNull(),
  objectKey: text("object_key"),
  mimeType: text("mime_type"),
  bytes: integer("bytes"),
  width: integer("width"),
  height: integer("height"),
  createdAt: time("created_at").notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "generation_outputs_job_id_fkey", columns: [t.jobId], foreignColumns: [generationJobs.id] }).onDelete("cascade"),
  check("generation_outputs_kind_check", sql`${t.kind} IN ('image','video','audio','text')`),
]);

export const videoTasks = pgTable("video_tasks", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().unique("video_tasks_job_id_key"),
  providerId: text("provider_id").notNull(),
  upstreamTaskId: text("upstream_task_id").notNull(),
  status: text("status").notNull().default("queued"),
  outputObjectKey: text("output_object_key"),
  lastPolledAt: time("last_polled_at"),
  createdAt: time("created_at").notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "video_tasks_job_id_fkey", columns: [t.jobId], foreignColumns: [generationJobs.id] }).onDelete("cascade"),
  foreignKey({ name: "video_tasks_provider_id_fkey", columns: [t.providerId], foreignColumns: [providers.id] }),
]);

export const redeemCodes = pgTable("redeem_codes", {
  code: text("code").primaryKey(),
  credits: integer("credits").notNull(),
  kind: text("kind", { enum: ["purchase", "gift"] }).notNull(),
  validDays: integer("valid_days"),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  expiresAt: time("expires_at"),
  createdBy: text("created_by").notNull(),
  note: text("note"),
  createdAt: time("created_at").notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "redeem_codes_created_by_fkey", columns: [t.createdBy], foreignColumns: [users.id] }),
  check("redeem_codes_credits_check", sql`${t.credits} > 0`),
  check("redeem_codes_kind_check", sql`${t.kind} IN ('purchase','gift')`),
]);

export const redeemCodeUses = pgTable("redeem_code_uses", {
  code: text("code").notNull(),
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id").notNull(),
  bucketId: text("bucket_id").notNull(),
  usedAt: time("used_at").notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: "redeem_code_uses_pkey", columns: [t.code, t.workspaceId] }),
  foreignKey({ name: "redeem_code_uses_code_fkey", columns: [t.code], foreignColumns: [redeemCodes.code] }),
  foreignKey({ name: "redeem_code_uses_workspace_id_fkey", columns: [t.workspaceId], foreignColumns: [workspaces.id] }).onDelete("cascade"),
  foreignKey({ name: "redeem_code_uses_user_id_fkey", columns: [t.userId], foreignColumns: [users.id] }),
  foreignKey({ name: "redeem_code_uses_bucket_id_fkey", columns: [t.bucketId], foreignColumns: [creditBuckets.id] }),
]);

export const creditPackages = pgTable("credit_packages", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  credits: integer("credits").notNull(),
  bonusCredits: integer("bonus_credits").notNull().default(0),
  priceCents: integer("price_cents").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  sort: integer("sort").notNull().default(0),
});

// 订阅套餐目录：id 与 workspaces.plan 取值一致，管理员维护每月点数与价格说明（支付二期接入）。
export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  monthlyCredits: integer("monthly_credits").notNull(),
  priceText: text("price_text"),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  sort: integer("sort").notNull().default(0),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (t) => [
  check("plans_id_check", sql`${t.id} IN ('free','team','enterprise')`),
  check("plans_monthly_credits_check", sql`${t.monthlyCredits} >= 0`),
]);

// 用户提交的升级申请；管理员批准后切换套餐并发放当期点数。每个工作区同时只能有一条待处理申请。
export const planUpgradeRequests = pgTable("plan_upgrade_requests", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id").notNull(),
  planId: text("plan_id").notNull(),
  fromPlan: text("from_plan").notNull(),
  note: text("note"),
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  reviewedBy: text("reviewed_by"),
  reviewNote: text("review_note"),
  createdAt: time("created_at").notNull().defaultNow(),
  reviewedAt: time("reviewed_at"),
}, (t) => [
  foreignKey({ name: "plan_upgrade_requests_workspace_id_fkey", columns: [t.workspaceId], foreignColumns: [workspaces.id] }).onDelete("cascade"),
  foreignKey({ name: "plan_upgrade_requests_user_id_fkey", columns: [t.userId], foreignColumns: [users.id] }),
  foreignKey({ name: "plan_upgrade_requests_plan_id_fkey", columns: [t.planId], foreignColumns: [plans.id] }),
  foreignKey({ name: "plan_upgrade_requests_reviewed_by_fkey", columns: [t.reviewedBy], foreignColumns: [users.id] }),
  check("plan_upgrade_requests_status_check", sql`${t.status} IN ('pending','approved','rejected')`),
  uniqueIndex("plan_upgrade_requests_pending_key").on(t.workspaceId).where(sql`${t.status} = 'pending'`),
  index("plan_upgrade_requests_status_idx").on(t.status, t.createdAt),
]);

export const paymentOrders = pgTable("payment_orders", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  userId: text("user_id").notNull(),
  packageId: text("package_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  provider: text("provider").notNull(),
  status: text("status", { enum: ["pending", "paid", "closed", "refunded"] }).notNull(),
  providerRef: text("provider_ref"),
  rawNotify: jsonb("raw_notify").$type<Record<string, unknown>>(),
  createdAt: time("created_at").notNull().defaultNow(),
  paidAt: time("paid_at"),
}, (t) => [
  foreignKey({ name: "payment_orders_workspace_id_fkey", columns: [t.workspaceId], foreignColumns: [workspaces.id] }),
  foreignKey({ name: "payment_orders_user_id_fkey", columns: [t.userId], foreignColumns: [users.id] }),
  foreignKey({ name: "payment_orders_package_id_fkey", columns: [t.packageId], foreignColumns: [creditPackages.id] }),
  check("payment_orders_status_check", sql`${t.status} IN ('pending','paid','closed','refunded')`),
]);

export const brands = pgTable("brands", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  industry: text("industry"),
  description: text("description"),
  requiredTerms: text("required_terms").array().notNull().default(sql`'{}'::text[]`),
  avoidTerms: text("avoid_terms").array().notNull().default(sql`'{}'::text[]`),
  defaultParams: jsonb("default_params").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  enforced: boolean("enforced").notNull().default(false),
  editorUserIds: text("editor_user_ids").array().notNull().default(sql`'{}'::text[]`),
  createdBy: text("created_by").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "brands_workspace_id_fkey", columns: [t.workspaceId], foreignColumns: [workspaces.id] }).onDelete("cascade"),
  foreignKey({ name: "brands_created_by_fkey", columns: [t.createdBy], foreignColumns: [users.id] }),
  index("brands_ws_idx").on(t.workspaceId),
]);

export const brandColors = pgTable("brand_colors", {
  id: text("id").primaryKey(),
  brandId: text("brand_id").notNull(),
  name: text("name").notNull(),
  role: text("role", { enum: ["primary", "secondary", "background", "accent"] }).notNull(),
  hex: text("hex").notNull(),
  sort: integer("sort").notNull().default(0),
}, (t) => [
  foreignKey({ name: "brand_colors_brand_id_fkey", columns: [t.brandId], foreignColumns: [brands.id] }).onDelete("cascade"),
  check("brand_colors_role_check", sql`${t.role} IN ('primary','secondary','background','accent')`),
  check("brand_colors_hex_check", sql`${t.hex} ~ '^#[0-9A-Fa-f]{6}$'`),
]);

export const brandAssets = pgTable("brand_assets", {
  id: text("id").primaryKey(),
  brandId: text("brand_id").notNull(),
  kind: text("kind", { enum: ["logo", "sku", "style_ref"] }).notNull(),
  title: text("title").notNull(),
  spec: text("spec"),
  objectKey: text("object_key").notNull(),
  mimeType: text("mime_type").notNull(),
  width: integer("width"),
  height: integer("height"),
  bytes: integer("bytes"),
  attachOnGenerate: boolean("attach_on_generate").notNull().default(false),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  sort: integer("sort").notNull().default(0),
  createdAt: time("created_at").notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "brand_assets_brand_id_fkey", columns: [t.brandId], foreignColumns: [brands.id] }).onDelete("cascade"),
  check("brand_assets_kind_check", sql`${t.kind} IN ('logo','sku','style_ref')`),
  index("brand_assets_brand_kind_idx").on(t.brandId, t.kind),
]);

export const templates = pgTable("templates", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id"),
  name: text("name").notNull(),
  category: text("category").notNull(),
  description: text("description").notNull().default(""),
  coverObjectKey: text("cover_object_key"),
  previewNodes: text("preview_nodes").array().notNull().default(sql`'{}'::text[]`),
  body: jsonb("body").$type<Record<string, unknown>>().notNull(),
  estimateCredits: integer("estimate_credits").notNull().default(0),
  useCount: integer("use_count").notNull().default(0),
  isPublished: boolean("is_published").notNull().default(true),
  createdBy: text("created_by"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "templates_workspace_id_fkey", columns: [t.workspaceId], foreignColumns: [workspaces.id] }).onDelete("cascade"),
  foreignKey({ name: "templates_created_by_fkey", columns: [t.createdBy], foreignColumns: [users.id] }),
  index("templates_ws_cat_idx").on(t.workspaceId, t.category),
]);
