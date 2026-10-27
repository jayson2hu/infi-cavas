import { env } from "../env";
import { ApiError } from "../lib/errors";

export function checkPrompt(prompt: string) {
  const normalized = prompt.toLocaleLowerCase();
  if (env.MODERATION_BLOCKLIST.some((word) => normalized.includes(word.toLocaleLowerCase()))) throw new ApiError(422, "content_blocked", "内容包含平台禁止的词语，请修改后重试");
}
// Separate result hook allows a deployment to add its moderation service later.
export function checkResult(text: string) { checkPrompt(text); }

export function responseText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(responseText).join("\n");
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return responseText(item.output ?? item.output_text ?? item.content ?? item.text ?? item.input);
  }
  return "";
}
