-- 无限画布二开 · 数据库结构（PostgreSQL 16）
-- 用 Drizzle 在 server/src/db/schema.ts 中一一实现；本文件是权威定义。
-- 约定：主键为带前缀的 text id（如 usr_xxx），由应用层用 nanoid 生成；时间统一 timestamptz；点数为 integer。

-- ========== 账号与工作区 ==========

CREATE TABLE users (
  id                 text PRIMARY KEY,                 -- usr_
  email              text NOT NULL UNIQUE,             -- 存小写
  password_hash      text NOT NULL,                    -- argon2id
  name               text NOT NULL,
  avatar_url         text,
  is_platform_admin  boolean NOT NULL DEFAULT false,
  last_workspace_id  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id           text PRIMARY KEY,                       -- ses_
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,                   -- sha256(cookie token)
  user_agent   text,
  ip           text,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE workspaces (
  id                    text PRIMARY KEY,              -- ws_
  name                  text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('personal','team')),
  owner_id              text NOT NULL REFERENCES users(id),
  plan                  text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','team','enterprise')),
  plan_monthly_credits  integer NOT NULL DEFAULT 0,
  period_start          timestamptz NOT NULL DEFAULT now(),
  period_end            timestamptz NOT NULL DEFAULT (now() + interval '1 month'),
  default_brand_id      text,                          -- 指向 brands.id（应用层维护，避免循环外键）
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner','admin','member')),
  monthly_cap   integer,                               -- null = 不限；仅对 member 生效
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);

CREATE TABLE workspace_invites (
  token         text PRIMARY KEY,                      -- 32 字节随机 base64url
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('admin','member')),
  created_by    text NOT NULL REFERENCES users(id),
  expires_at    timestamptz NOT NULL,
  accepted_by   text REFERENCES users(id),
  accepted_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
  id            text PRIMARY KEY,                      -- tok_
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  token_hash    text NOT NULL UNIQUE,                  -- sha256("ick_...")
  last4         text NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ========== 模型与定价 ==========

CREATE TABLE providers (
  id                 text PRIMARY KEY,                 -- prv_
  name               text NOT NULL,
  base_url           text NOT NULL,                    -- 不含 /v1，网关拼接
  api_key_encrypted  text NOT NULL,                    -- AES-256-GCM：base64(iv|tag|ciphertext)
  api_format         text NOT NULL DEFAULT 'openai' CHECK (api_format IN ('openai')),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE models (
  id                    text PRIMARY KEY,              -- 对外模型名，如 'gpt-image-2'
  display_name          text NOT NULL,
  capability            text NOT NULL CHECK (capability IN ('image','video','text','audio')),
  supports_edit         boolean NOT NULL DEFAULT false, -- 图片模型是否支持 /images/edits
  max_reference_images  integer NOT NULL DEFAULT 8,
  is_active             boolean NOT NULL DEFAULT true,
  sort                  integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_routes (
  model_id        text NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  provider_id     text NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_model  text NOT NULL,                       -- 上游实际模型名
  priority        integer NOT NULL DEFAULT 0,          -- 小的优先
  PRIMARY KEY (model_id, provider_id)
);

CREATE TABLE pricing_rules (
  model_id    text PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  unit        text NOT NULL CHECK (unit IN ('per_image','per_second','per_1k_tokens','per_1k_chars')),
  config      jsonb NOT NULL,
  -- config 结构：
  --   per_image:     {"standard": 4, "hd": 8}
  --   per_second:    {"price": 12}
  --   per_1k_tokens: {"input": 0.5, "output": 2, "hold": 10, "min": 1}
  --   per_1k_chars:  {"price": 2}
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ========== 点数账本 ==========

CREATE TABLE credit_buckets (
  id            text PRIMARY KEY,                      -- cb_
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('subscription','purchase','gift')),
  granted       integer NOT NULL CHECK (granted >= 0),
  remaining     integer NOT NULL CHECK (remaining >= 0),
  expires_at    timestamptz,                           -- null = 不过期
  source        text NOT NULL,                         -- signup | plan_period | redeem:<code> | admin:<userId> | order:<id>
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_buckets_ws_idx ON credit_buckets(workspace_id) WHERE remaining > 0;

CREATE TABLE generation_jobs (
  id                text PRIMARY KEY,                  -- job_
  workspace_id      text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id           text NOT NULL REFERENCES users(id),
  api_token_id      text REFERENCES api_tokens(id),
  model_id          text NOT NULL REFERENCES models(id),
  provider_id       text REFERENCES providers(id),
  capability        text NOT NULL CHECK (capability IN ('image','video','text','audio')),
  endpoint          text NOT NULL,                     -- 'images/generations' 等
  status            text NOT NULL CHECK (status IN ('held','succeeded','failed','timeout')),
  estimate_credits  integer NOT NULL,
  charged_credits   integer NOT NULL DEFAULT 0,
  hold_breakdown    jsonb NOT NULL DEFAULT '[]',       -- [{"bucketId":"cb_x","amount":12}]
  overdraft         boolean NOT NULL DEFAULT false,
  brand_id          text,
  project_id        text,                              -- 前端画布项目 id（本期为浏览器本地 id）
  node_id           text,
  source            text,                              -- canvas | image-workbench | video-workbench | plugin | agent | api
  params            jsonb NOT NULL DEFAULT '{}',       -- n/size/seconds/quality 等，不存提示词以外的二进制
  prompt            text,                              -- 注入后的最终提示词（便于审计与生成记录）
  usage             jsonb,                             -- 上游返回的 usage
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);
CREATE INDEX generation_jobs_ws_created_idx ON generation_jobs(workspace_id, created_at DESC);
CREATE INDEX generation_jobs_user_month_idx ON generation_jobs(workspace_id, user_id, created_at);
CREATE INDEX generation_jobs_held_idx ON generation_jobs(created_at) WHERE status = 'held';

CREATE TABLE credit_transactions (
  id            text PRIMARY KEY,                      -- ctx_
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       text REFERENCES users(id),
  type          text NOT NULL CHECK (type IN ('grant','hold','settle','refund','expire','adjust')),
  amount        integer NOT NULL,                      -- 正=加点，负=扣点（hold 为负，refund 为正，settle 为差额）
  breakdown     jsonb NOT NULL DEFAULT '[]',
  job_id        text REFERENCES generation_jobs(id),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_transactions_ws_created_idx ON credit_transactions(workspace_id, created_at DESC);

CREATE TABLE generation_outputs (
  id          text PRIMARY KEY,                        -- out_
  job_id      text NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('image','video','audio','text')),
  object_key  text,                                    -- S3：ws/<wsId>/outputs/<jobId>/<n>.<ext>
  mime_type   text,
  bytes       integer,
  width       integer,
  height      integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE video_tasks (
  id                text PRIMARY KEY,                  -- vt_（返回给前端的任务 id）
  job_id            text NOT NULL UNIQUE REFERENCES generation_jobs(id) ON DELETE CASCADE,
  provider_id       text NOT NULL REFERENCES providers(id),
  upstream_task_id  text NOT NULL,
  status            text NOT NULL DEFAULT 'queued',    -- 上游状态镜像
  output_object_key text,
  last_polled_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE redeem_codes (
  code        text PRIMARY KEY,                        -- 16 位，去掉易混字符
  credits     integer NOT NULL CHECK (credits > 0),
  kind        text NOT NULL CHECK (kind IN ('purchase','gift')),
  valid_days  integer,                                 -- 兑换后点数有效天数；null = 不过期
  max_uses    integer NOT NULL DEFAULT 1,
  used_count  integer NOT NULL DEFAULT 0,
  expires_at  timestamptz,                             -- 兑换码本身的有效期
  created_by  text NOT NULL REFERENCES users(id),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE redeem_code_uses (
  code          text NOT NULL REFERENCES redeem_codes(code),
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id),
  bucket_id     text NOT NULL REFERENCES credit_buckets(id),
  used_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, workspace_id)                     -- 同一工作区同一码只能用一次
);

-- 第 2 期在线支付预留
CREATE TABLE credit_packages (
  id            text PRIMARY KEY,                      -- pkg_
  name          text NOT NULL,
  credits       integer NOT NULL,
  bonus_credits integer NOT NULL DEFAULT 0,
  price_cents   integer NOT NULL,                      -- 人民币分；运营定价
  is_active     boolean NOT NULL DEFAULT true,
  sort          integer NOT NULL DEFAULT 0
);

CREATE TABLE payment_orders (
  id            text PRIMARY KEY,                      -- ord_
  workspace_id  text NOT NULL REFERENCES workspaces(id),
  user_id       text NOT NULL REFERENCES users(id),
  package_id    text NOT NULL REFERENCES credit_packages(id),
  amount_cents  integer NOT NULL,
  provider      text NOT NULL,                         -- wechat | alipay
  status        text NOT NULL CHECK (status IN ('pending','paid','closed','refunded')),
  provider_ref  text,
  raw_notify    jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  paid_at       timestamptz
);

-- ========== 品牌套件 ==========

CREATE TABLE brands (
  id                 text PRIMARY KEY,                 -- brd_
  workspace_id       text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               text NOT NULL,
  industry           text,
  description        text,
  required_terms     text[] NOT NULL DEFAULT '{}',     -- 必带描述
  avoid_terms        text[] NOT NULL DEFAULT '{}',     -- 禁用词（作为"避免"注入，不拦截）
  default_params     jsonb NOT NULL DEFAULT '{}',      -- {"model":"gpt-image-2","quality":"high"}
  enforced           boolean NOT NULL DEFAULT false,   -- 强制套用，忽略 X-IC-Brand: none
  editor_user_ids    text[] NOT NULL DEFAULT '{}',     -- 额外可编辑的 member
  created_by         text NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brands_ws_idx ON brands(workspace_id);

CREATE TABLE brand_colors (
  id        text PRIMARY KEY,                          -- bc_
  brand_id  text NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name      text NOT NULL,                             -- '主色 · 松针绿'
  role      text NOT NULL CHECK (role IN ('primary','secondary','background','accent')),
  hex       text NOT NULL CHECK (hex ~ '^#[0-9A-Fa-f]{6}$'),
  sort      integer NOT NULL DEFAULT 0
);

CREATE TABLE brand_assets (
  id                  text PRIMARY KEY,                -- ba_
  brand_id            text NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('logo','sku','style_ref')),
  title               text NOT NULL,
  spec                text,                            -- SKU 规格，如 '500ml · 秋季限定'
  object_key          text NOT NULL,
  mime_type           text NOT NULL,
  width               integer,
  height              integer,
  bytes               integer,
  attach_on_generate  boolean NOT NULL DEFAULT false,  -- 仅 style_ref 有意义
  tags                text[] NOT NULL DEFAULT '{}',
  sort                integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brand_assets_brand_kind_idx ON brand_assets(brand_id, kind);

-- ========== 模板 ==========

CREATE TABLE templates (
  id              text PRIMARY KEY,                    -- tpl_
  workspace_id    text REFERENCES workspaces(id) ON DELETE CASCADE,  -- null = 官方模板
  name            text NOT NULL,
  category        text NOT NULL,                       -- ecommerce | short_video | brand | social | other
  description     text NOT NULL DEFAULT '',
  cover_object_key text,
  preview_nodes   text[] NOT NULL DEFAULT '{}',        -- 卡片上 3 个节点小标签，如 {'商品图','场景 ×5','尺寸适配'}
  body            jsonb NOT NULL,                      -- 符合 specs/template.schema.json
  estimate_credits integer NOT NULL DEFAULT 0,         -- 由 body.steps[].estimate 汇总，保存时计算
  use_count       integer NOT NULL DEFAULT 0,
  is_published    boolean NOT NULL DEFAULT true,
  created_by      text REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX templates_ws_cat_idx ON templates(workspace_id, category);

-- ========== 种子数据（默认定价示例，可在 seed.ts 中实现） ==========
-- INSERT INTO models (id, display_name, capability, supports_edit, sort) VALUES
--   ('gpt-image-2','GPT Image 2','image',true,10),
--   ('sora-2','Sora 2','video',false,20),
--   ('gpt-5.5','GPT-5.5','text',false,30),
--   ('gpt-4o-mini-tts','TTS','audio',false,40);
-- INSERT INTO pricing_rules (model_id, unit, config) VALUES
--   ('gpt-image-2','per_image','{"standard":4,"hd":8}'),
--   ('sora-2','per_second','{"price":12}'),
--   ('gpt-5.5','per_1k_tokens','{"input":0.5,"output":2,"hold":10,"min":1}'),
--   ('gpt-4o-mini-tts','per_1k_chars','{"price":2}');
-- 模型名与上游映射以实际采购的供应商为准，以上仅示例。
