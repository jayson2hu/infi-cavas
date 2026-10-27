import { expect, test } from "bun:test";
import { actual, estimate, MAX_CREDITS, validatePricingRule, type PricingRule } from "../src/gateway/pricing";

const image: PricingRule = { unit: "per_image", config: { standard: 4, hd: 8 } };
const video: PricingRule = { unit: "per_second", config: { price: 12 } };
const text: PricingRule = { unit: "per_1k_tokens", config: { input: 0.5, output: 2, hold: 10, min: 1 } };
const audio: PricingRule = { unit: "per_1k_chars", config: { price: 2 } };

test("图片按最长边 1536/1537 分档并按实际图片数量结算", () => {
  expect(estimate(image, { n: 3, size: "1536x1024" })).toBe(12);
  expect(estimate(image, { n: 3, size: "1024x1537" })).toBe(24);
  expect(estimate(image, { n: "2", size: "auto" })).toBe(8);
  expect(estimate(image, {})).toBe(4);
  expect(actual(image, { n: 3, size: "1536x1536" }, { data: [{ b64_json: "a" }, { b64_json: "b" }] })).toBe(8);
  expect(actual(image, { n: 1, size: "1537x1024" }, { data: [{ b64_json: "a" }] })).toBe(8);
  expect(actual(image, {}, { data: [] })).toBe(0);
});

test("视频估价和实际计价都按秒数，支持 multipart 数字字符串并向上取整", () => {
  expect(estimate(video, { seconds: "6" })).toBe(72);
  expect(actual(video, { seconds: 6 })).toBe(72);
  expect(estimate({ unit: "per_second", config: { price: 0.1 } }, { seconds: 10 })).toBe(1);
  expect(estimate({ unit: "per_second", config: { price: 0.25 } }, { seconds: 5 })).toBe(2);
});

test("文本按 usage 的输入输出 token 合计取整，缺失 usage 按冻结额，最少 1 点", () => {
  expect(estimate(text, {})).toBe(10);
  expect(actual(text, {}, { usage: { input_tokens: 1000, output_tokens: 1000 } })).toBe(3);
  expect(actual(text, {}, { type: "response.completed", response: { usage: { input_tokens: 2000, output_tokens: 1000 } } })).toBe(3);
  expect(actual(text, {}, { usage: { input_tokens: 0, output_tokens: 0 } })).toBe(1);
  expect(actual(text, {}, { usage: { input_tokens: 1, output_tokens: 0 } })).toBe(1);
  expect(actual(text, {}, {})).toBe(10);
  expect(actual(text, {}, { usage: {} })).toBe(10);
});

test("十进制价格不因浮点误差多扣或忽略跨整数边界的小额费用", () => {
  const decimals: PricingRule = { unit: "per_1k_tokens", config: { input: 0.1, output: 0.2, hold: 10, min: 1 } };
  expect(actual(decimals, {}, { usage: { input_tokens: 6000, output_tokens: 2000 } })).toBe(1);
  expect(actual({ ...decimals, config: { ...decimals.config, input: 1, output: 5e-324 } }, {}, { usage: { input_tokens: 1000, output_tokens: 1 } })).toBe(2);
});

test("语音按 Unicode 字符数向上取整，与估价保持一致", () => {
  expect(estimate(audio, { input: "茶".repeat(1000) })).toBe(2);
  expect(actual(audio, { input: "茶".repeat(1001) })).toBe(3);
  expect(estimate(audio, { input: "🍵".repeat(500) })).toBe(1);
  expect(estimate(audio, { input: "" })).toBe(0);
});

test("无效定价、负值、非有限值、非整数张数与点数溢出被拒绝", () => {
  for (const value of [-1, NaN, Infinity, -Infinity]) {
    expect(() => validatePricingRule({ unit: "per_image", config: { standard: value, hd: 8 } })).toThrow();
    expect(() => estimate(image, { n: value })).toThrow();
    expect(() => estimate(video, { seconds: value })).toThrow();
    expect(() => actual(text, {}, { usage: { input_tokens: value, output_tokens: 1 } })).toThrow();
  }
  expect(() => estimate(image, { n: 1.1 })).toThrow();
  expect(() => estimate(image, { n: "" })).toThrow();
  expect(() => estimate(image, { size: "1536x-1" })).toThrow();
  expect(() => estimate(image, { size: "0x1024" })).toThrow();
  expect(() => estimate(image, { size: "1:1" })).toThrow();
  expect(() => estimate(image, { n: MAX_CREDITS })).toThrow();
  expect(() => estimate(video, { seconds: Number.MAX_SAFE_INTEGER })).toThrow();
  expect(() => estimate(audio, { input: 100 })).toThrow();
  expect(() => actual(image, {}, {})).toThrow();
  expect(() => validatePricingRule({ unit: "per_1k_tokens", config: { input: 1, output: 1, hold: 1.5, min: 1 } })).toThrow();
  expect(validatePricingRule({ unit: "per_1k_tokens", config: { input: 1, output: 1 } }).config).toEqual({ input: 1, output: 1, hold: 10, min: 1 });
});
