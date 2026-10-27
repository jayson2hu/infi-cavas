import { platformApi } from "./client";
import type { Me } from "./types";

export type RegisterInput = { email: string; password: string; name: string; inviteToken?: string };
export const fetchSession = async (workspaceId?: string) => (await platformApi.get<Me>("/auth/me", { headers: workspaceId ? { "X-IC-Workspace": workspaceId } : undefined })).data;
export const login = async (input: { email: string; password: string }) => (await platformApi.post<Me>("/auth/login", input)).data;
export const register = async (input: RegisterInput) => (await platformApi.post<Me>("/auth/register", input)).data;
export const logout = async () => { await platformApi.post("/auth/logout"); };
