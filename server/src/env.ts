import { z } from "zod";

const boolean = z.enum(["true", "false"]).transform((value) => value === "true");

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default("127.0.0.1"),
  TRUST_PROXY: boolean.default(false),
  DATABASE_URL: z.string().url(),
  APP_ORIGIN: z.string().url(),
  APP_SECRET: z.string().min(32),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("infinite-canvas"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: boolean.default(true),
  BILLING_ENABLED: boolean.default(true),
  SIGNUP_BONUS_CREDITS: z.coerce.number().int().nonnegative().max(2147483647).default(200),
  // 每个 IP 每小时可注册次数，0 表示不限；凭邀请链接注册不计入。
  SIGNUP_RATE_LIMIT_PER_HOUR: z.coerce.number().int().nonnegative().default(5),
  ALLOW_SIGNUP: boolean.default(true),
  ADMIN_EMAILS: z.string().default("").transform((value) => value.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean)),
  MODERATION_BLOCKLIST: z.string().default("").transform((value) => value.split(",").map((word) => word.trim()).filter(Boolean)),
});

export type Environment = z.infer<typeof envSchema>;
export const env = envSchema.parse(process.env);
