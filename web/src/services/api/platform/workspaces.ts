import { platformApi } from "./client";
import type { Invite, InviteInfo, Member, Workspace } from "./types";

const base = (id: string) => `/workspaces/${encodeURIComponent(id)}`;
export const createWorkspace = async (name: string) => (await platformApi.post<Workspace>("/workspaces", { name })).data;
export const updateWorkspace = async (id: string, input: { name?: string; defaultBrandId?: string | null }) => (await platformApi.patch<Workspace>(base(id), input)).data;
export const fetchMembers = async (id: string, signal?: AbortSignal) => (await platformApi.get<Member[]>(`${base(id)}/members`, { signal, headers: { "X-IC-Workspace": id } })).data;
export const updateMember = async (id: string, userId: string, input: { role?: "admin" | "member"; monthlyCap?: number | null }) => (await platformApi.patch<Member>(`${base(id)}/members/${encodeURIComponent(userId)}`, input, { headers: { "X-IC-Workspace": id } })).data;
export const removeMember = async (id: string, userId: string) => { await platformApi.delete(`${base(id)}/members/${encodeURIComponent(userId)}`, { headers: { "X-IC-Workspace": id } }); };
export const createInvite = async (id: string, role: "admin" | "member") => (await platformApi.post<Invite>(`${base(id)}/invites`, { role }, { headers: { "X-IC-Workspace": id } })).data;
export const fetchInvite = async (token: string, signal?: AbortSignal) => (await platformApi.get<InviteInfo>(`/invites/${encodeURIComponent(token)}`, { signal })).data;
export const acceptInvite = async (token: string) => (await platformApi.post<Workspace>(`/invites/${encodeURIComponent(token)}/accept`)).data;
