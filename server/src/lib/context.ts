import type { users, workspaces, workspaceMembers } from "../db/schema";

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Membership = typeof workspaceMembers.$inferSelect;
export type AppEnv = { Variables: { user: User; workspace: Workspace; membership: Membership; apiTokenId?: string } };
export const publicUser = (user: User) => ({ id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, isPlatformAdmin: user.isPlatformAdmin });
