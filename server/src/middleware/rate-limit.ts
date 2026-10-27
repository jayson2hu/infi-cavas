import { ApiError } from "../lib/errors";

export function createRateLimiter(limit: number | (() => number), intervalMs: number) {
  const entries = new Map<string, { count: number; reset: number }>();
  const current = (key: string) => {
    const now = Date.now();
    for (const [entryKey, entry] of entries) if (entry.reset <= now) entries.delete(entryKey);
    let entry = entries.get(key);
    if (!entry) { entry = { count: 0, reset: now + intervalMs }; entries.set(key, entry); }
    return entry;
  };
  return {
    check(key: string) { if (current(key).count >= (typeof limit === "function" ? limit() : limit)) throw new ApiError(429, "rate_limited", "请求过于频繁，请稍后再试"); },
    hit(key: string) { current(key).count += 1; },
    clear(key: string) { entries.delete(key); },
  };
}
