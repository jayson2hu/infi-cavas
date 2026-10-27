import { Hono } from "hono";
import { ZodError } from "zod";
import type { AppEnv } from "./lib/context";
import { ApiError } from "./lib/errors";
import { checkOrigin } from "./middleware/origin";
import { authRoutes } from "./routes/auth";
import { workspaceRoutes, inviteRoutes } from "./routes/workspaces";
import { billingRoutes } from "./routes/billing";
import { createGatewayRoutes, type GatewayOptions } from "./gateway/router";
import { createAdminRoutes } from "./routes/admin";
import { adminBillingRoutes } from "./routes/admin-billing";
import { brandRoutes } from "./routes/brands";
import { fileRoutes, uploadRoutes } from "./routes/uploads";
import { templateRoutes } from "./routes/templates";

export function createApp(options: GatewayOptions = {}) {
  const app = new Hono<AppEnv>();
  app.use("/api/*", checkOrigin);
  app.get("/api/health", (context) => context.json({ ok: true }));
  app.route("/api/auth", authRoutes);
  app.route("/api/workspaces", workspaceRoutes);
  app.route("/api/invites", inviteRoutes);
  app.route("/api/billing", billingRoutes);
  app.route("/api/brands", brandRoutes);
  app.route("/api/uploads", uploadRoutes);
  app.route("/api/files", fileRoutes);
  app.route("/api/templates", templateRoutes);
  app.route("/api/gateway/v1", createGatewayRoutes(options));
  app.route("/api/admin", createAdminRoutes(options));
  app.route("/api/admin", adminBillingRoutes);
  app.notFound((context) => context.json({ error: { code: "not_found", message: "接口不存在" } }, 404));
  app.onError((error, context) => {
    if (error instanceof ApiError) return context.json({ error: { code: error.code, message: error.message, ...error.extra } }, error.status);
    if (error instanceof ZodError) return context.json({ error: { code: "validation_error", message: "请求参数不合法", fields: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) } }, 422);
    if (error instanceof SyntaxError) return context.json({ error: { code: "invalid_json", message: "请求内容不是有效 JSON" } }, 400);
    return context.json({ error: { code: "internal_error", message: "服务暂时不可用" } }, 500);
  });
  return app;
}
