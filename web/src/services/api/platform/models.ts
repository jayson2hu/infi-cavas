import { platformApi } from "./client";
import type { PlatformModel } from "./types";
export const fetchPlatformModels = async (workspaceId: string, signal?: AbortSignal) => (await platformApi.get<{ object: "list"; data: PlatformModel[] }>("/gateway/v1/models", { signal, headers: { "X-IC-Workspace": workspaceId } })).data.data;
