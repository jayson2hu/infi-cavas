import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  constructor(public status: ContentfulStatusCode, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export function invariant(condition: unknown, status: ContentfulStatusCode, code: string, message: string): asserts condition {
  if (!condition) throw new ApiError(status, code, message);
}
