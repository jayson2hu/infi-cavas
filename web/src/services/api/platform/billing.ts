import { platformApi } from "./client";
import type { BillingSummary, UsageDay, UsageMember, CreditTransaction, CreditPackage, GenerationJob, Page } from "./types";

export const fetchBillingSummary = async (workspaceId: string, signal?: AbortSignal) => (await platformApi.get<BillingSummary>("/billing/summary", { signal, headers: { "X-IC-Workspace": workspaceId } })).data;
const context = (workspaceId: string, signal?: AbortSignal) => ({ signal, headers: { "X-IC-Workspace": workspaceId } });
export const fetchDailyUsage = async (workspaceId: string, signal?: AbortSignal) => (await platformApi.get<UsageDay[]>("/billing/daily", context(workspaceId, signal))).data;
export const fetchMemberUsage = async (workspaceId: string, signal?: AbortSignal) => (await platformApi.get<UsageMember[]>("/billing/members", context(workspaceId, signal))).data;
export const fetchJobs = async (workspaceId: string, params: { cursor?: string; status?: string; brandId?: string } = {}, signal?: AbortSignal) => (await platformApi.get<Page<GenerationJob>>("/billing/jobs", { ...context(workspaceId, signal), params })).data;
export const fetchTransactions = async (workspaceId: string, cursor?: string, signal?: AbortSignal) => (await platformApi.get<Page<CreditTransaction>>("/billing/transactions", { ...context(workspaceId, signal), params: { cursor } })).data;
export const fetchCreditPackages = async (workspaceId: string, signal?: AbortSignal) => (await platformApi.get<CreditPackage[]>("/billing/packages", context(workspaceId, signal))).data;
export const redeemCredits = async (workspaceId: string, code: string) => (await platformApi.post<{ credits: number; balance: number }>("/billing/redeem", { code }, context(workspaceId))).data;

export type PlanId = "free" | "team" | "enterprise";
export type PlanOption = { id: PlanId; name: string; monthlyCredits: number; priceText: string | null; description: string | null };
export type PlanRequestStatus = "pending" | "approved" | "rejected";
export type PlanRequest = { id: string; planId: PlanId; fromPlan: PlanId; note: string | null; status: PlanRequestStatus; reviewNote: string | null; createdAt: string; reviewedAt: string | null };
export type PlanCatalog = { currentPlan: PlanId; planMonthlyCredits: number; plans: PlanOption[]; latestRequest: PlanRequest | null };
export const fetchPlans = async (workspaceId: string, signal?: AbortSignal) => (await platformApi.get<PlanCatalog>("/billing/plans", context(workspaceId, signal))).data;
export const requestPlan = async (workspaceId: string, input: { planId: PlanId; note?: string }) => (await platformApi.post<PlanRequest>("/billing/plan-requests", input, context(workspaceId))).data;
