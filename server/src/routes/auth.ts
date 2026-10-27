import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "hono/bun";
import { z } from "zod";
import { db } from "../db/client";
import { sessions, users, workspaceMembers, workspaces } from "../db/schema";
import { env } from "../env";
import { grantInTransaction } from "../billing/ledger";
import { publicUser, type AppEnv, type User } from "../lib/context";
import { ApiError, invariant } from "../lib/errors";
import { id, randomToken, tokenHash } from "../lib/ids";
import { createRateLimiter } from "../middleware/rate-limit";
import { resolveClientIp } from "../middleware/client-ip";
import { cookieOptions, requireSession, SESSION_SECONDS, workspaceContext } from "../middleware/session";
import { acceptInvite, listWorkspaces } from "./workspaces";

export async function me(user: User) {
  const joined = await listWorkspaces(user.id);
  return { user: publicUser(user), workspaces: joined, currentWorkspaceId: joined.some((workspace) => workspace.id === user.lastWorkspaceId) ? user.lastWorkspaceId : joined[0]?.id ?? null };
}
const email = z.string().trim().email().transform((value) => value.toLowerCase());
const registerInput = z.object({ email, password: z.string().min(8), name: z.string().trim().min(1).max(40), inviteToken: z.string().optional() });

export const authRoutes = new Hono<AppEnv>();
authRoutes.post("/register", async (c) => {
  const input = registerInput.parse(await c.req.json());
  invariant(env.ALLOW_SIGNUP || input.inviteToken, 403, "signup_disabled", "注册已关闭，请使用邀请链接");
  const passwordHash = await Bun.password.hash(input.password, "argon2id");
  const token = randomToken();
  let user: User;
  try {
    user = await db.transaction(async (tx) => {
      const userId = id("usr");
      const workspaceId = id("ws");
      await tx.insert(users).values({ id: userId, email: input.email, passwordHash, name: input.name, isPlatformAdmin: env.ADMIN_EMAILS.includes(input.email), lastWorkspaceId: workspaceId });
      await tx.insert(workspaces).values({ id: workspaceId, name: `${input.name}的工作区`, kind: "personal", ownerId: userId });
      await tx.insert(workspaceMembers).values({ workspaceId, userId, role: "owner" });
      await grantInTransaction(tx, { workspaceId, userId, kind: "gift", amount: env.SIGNUP_BONUS_CREDITS, expiresAt: new Date(Date.now() + 30 * 86400000), source: "signup" });
      if (input.inviteToken) await acceptInvite(tx, input.inviteToken, userId);
      await tx.insert(sessions).values({ id: id("ses"), userId, tokenHash: tokenHash(token), userAgent: c.req.header("User-Agent"), expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000) });
      return (await tx.select().from(users).where(eq(users.id, userId)))[0];
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause ?? error as { code?: string; constraint_name?: string };
    if (cause.code === "23505" && cause.constraint_name === "users_email_key") throw new ApiError(409, "email_exists", "邮箱已注册");
    throw error;
  }
  setCookie(c, "ic_session", token, cookieOptions);
  return c.json(await me(user), 201);
});

const failedLogin = createRateLimiter(10, 5 * 60 * 1000);
authRoutes.post("/login", async (c) => {
  const input = z.object({ email, password: z.string().min(1) }).parse(await c.req.json());
  let socketIp: string | undefined;
  try { socketIp = getConnInfo(c).remote.address; } catch { /* In-process HTTP tests have no socket. */ }
  const ip = resolveClientIp(socketIp, c.req.header("X-Real-IP"), env.TRUST_PROXY);
  failedLogin.check(ip);
  const [user] = await db.select().from(users).where(eq(users.email, input.email));
  const valid = user && await Bun.password.verify(input.password, user.passwordHash);
  if (!valid) { failedLogin.hit(ip); throw new ApiError(401, "invalid_credentials", "邮箱或密码错误"); }
  const token = randomToken();
  await db.insert(sessions).values({ id: id("ses"), userId: user.id, tokenHash: tokenHash(token), userAgent: c.req.header("User-Agent"), ip, expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000) });
  setCookie(c, "ic_session", token, cookieOptions);
  return c.json(await me(user));
});
authRoutes.get("/me", requireSession, async (c) => {
  const requested = c.req.header("X-IC-Workspace");
  if (requested) {
    await workspaceContext(c, requested);
    await db.update(users).set({ lastWorkspaceId: requested }).where(eq(users.id, c.get("user").id));
    return c.json(await me({ ...c.get("user"), lastWorkspaceId: requested }));
  }
  return c.json(await me(c.get("user")));
});
authRoutes.post("/logout", requireSession, async (c) => {
  await db.delete(sessions).where(and(eq(sessions.userId, c.get("user").id), eq(sessions.tokenHash, tokenHash(getCookie(c, "ic_session")!))));
  deleteCookie(c, "ic_session", { ...cookieOptions, maxAge: 0 });
  return c.body(null, 204);
});
