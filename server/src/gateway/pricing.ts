import Decimal from "decimal.js";
import { z } from "zod";
import { invariant } from "../lib/errors";

// Keep even the smallest finite JS decimal alongside an integer before rounding upward.
const ExactDecimal = Decimal.clone({ precision: 400 });

export const MAX_CREDITS = 2147483647;
const price = z.number().finite().nonnegative().max(MAX_CREDITS);
export const pricingRuleSchema = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("per_image"), config: z.object({ standard: price, hd: price }).strict() }),
  z.object({ unit: z.literal("per_second"), config: z.object({ price }).strict() }),
  z.object({ unit: z.literal("per_1k_tokens"), config: z.object({ input: price, output: price, hold: price.int().min(1).default(10), min: price.int().min(1).default(1) }).strict() }),
  z.object({ unit: z.literal("per_1k_chars"), config: z.object({ price }).strict() }),
]);
export type PricingRule = { unit: "per_image" | "per_second" | "per_1k_tokens" | "per_1k_chars"; config: Record<string, number> };
export const validatePricingRule = (input: unknown): PricingRule => pricingRuleSchema.parse(input);

function amount(value: unknown, field: string, allowZero = false) {
  invariant(typeof value === "number" || typeof value === "string" && value.trim() !== "", 422, "invalid_pricing_input", `${field}必须是有效数字`);
  const number = Number(value);
  invariant(Number.isFinite(number) && number >= (allowZero ? 0 : Number.MIN_VALUE) && number <= Number.MAX_SAFE_INTEGER, 422, "invalid_pricing_input", `${field}超出有效范围`);
  return number;
}

function count(value: unknown, field: string, allowZero = false) {
  const number = amount(value, field, allowZero);
  invariant(Number.isSafeInteger(number), 422, "invalid_pricing_input", `${field}必须是整数`);
  return number;
}

function credits(value: Decimal) {
  const rounded = value.ceil();
  invariant(rounded.isFinite() && rounded.gte(0) && rounded.lte(MAX_CREDITS), 422, "credits_overflow", "计费点数超出有效范围");
  return rounded.toNumber();
}

function imagePrice(rule: PricingRule, size: unknown) {
  if (size === undefined || size === "auto") return rule.config.standard;
  invariant(typeof size === "string" && /^\d+x\d+$/.test(size), 422, "invalid_pricing_input", "图片尺寸必须为宽x高或auto");
  const dimensions = size.split("x").map((side) => count(side, "图片边长"));
  return rule.config[Math.max(...dimensions) <= 1536 ? "standard" : "hd"];
}

export function estimate(input: PricingRule, params: Record<string, unknown>) {
  const rule = validatePricingRule(input);
  switch (rule.unit) {
    case "per_image": return credits(new ExactDecimal(imagePrice(rule, params.size)).times(count(params.n ?? 1, "图片张数")));
    case "per_second": return credits(new ExactDecimal(rule.config.price).times(amount(params.seconds, "视频秒数")));
    case "per_1k_tokens": return rule.config.hold;
    case "per_1k_chars": {
      invariant(typeof params.input === "string", 422, "invalid_pricing_input", "语音内容必须是字符串");
      return credits(new ExactDecimal(Array.from(params.input).length).times(rule.config.price).div(1000));
    }
  }
}

const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function actual(input: PricingRule, params: Record<string, unknown>, response?: unknown) {
  const rule = validatePricingRule(input);
  const payload = record(response);
  if (rule.unit === "per_image") {
    const requested = count(params.n ?? 1, "图片张数");
    invariant(Array.isArray(payload?.data), 422, "invalid_upstream_usage", "上游未返回有效图片列表");
    // 上游多返回的图片不计费：用户只为请求的张数付费。
    return credits(new ExactDecimal(imagePrice(rule, params.size)).times(Math.min(payload.data.length, requested)));
  }
  if (rule.unit === "per_1k_tokens") {
    const usage = record(payload?.usage) ?? record(record(payload?.response)?.usage);
    if (!usage || usage.input_tokens === undefined || usage.output_tokens === undefined) return rule.config.hold;
    const inputTokens = count(usage.input_tokens, "输入token数量", true);
    const outputTokens = count(usage.output_tokens, "输出token数量", true);
    return Math.max(rule.config.min, credits(new ExactDecimal(inputTokens).times(rule.config.input).plus(new ExactDecimal(outputTokens).times(rule.config.output)).div(1000)));
  }
  return estimate(rule, params);
}
