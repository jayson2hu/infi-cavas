import { randomBytes } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://test@127.0.0.1:1/not_configured";
process.env.APP_ORIGIN ??= "http://localhost:3000";
process.env.APP_SECRET ??= randomBytes(32).toString("hex");
process.env.S3_ENDPOINT ??= "http://127.0.0.1:9000";
process.env.S3_ACCESS_KEY ??= "test-only";
process.env.S3_SECRET_KEY ??= "test-only";
