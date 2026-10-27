import { expect, test } from "bun:test";
import { applyBrandDefaults, injectBrand, selectBrandId, type BrandKit } from "../../shared/brand-inject";
import { validateImageBytes } from "../src/gateway/media";

const brand: BrandKit = {
  name: "松风", requiredTerms: ["自然光", "简约"], avoidTerms: ["霓虹", "水印"],
  colors: [{ name: "辅色", hex: "#C7A46A", sort: 1 }, { name: "主色", hex: "#1F3B2D", sort: 0 }],
  assets: [{ kind: "style_ref", attachOnGenerate: true, objectKey: "second", sort: 2 }, { kind: "sku", attachOnGenerate: true, objectKey: "sku", sort: 0 }, { kind: "style_ref", attachOnGenerate: false, objectKey: "disabled" }, { kind: "style_ref", attachOnGenerate: true, objectKey: "first", sort: 1 }],
};

test("品牌格式与预览一致，只追加启用的风格图且保留用户图优先", () => {
  const snapshot = JSON.stringify(brand);
  const result = injectBrand({ brand, prompt: "商品摄影", capability: "image", supportsEdit: true, maxReferenceImages: 2, originalReferenceCount: 1 });
  expect(result.text).toBe("[品牌] 松风\n[风格] 自然光，简约\n[色彩] 主色 #1F3B2D，辅色 #C7A46A\n[避免] 霓虹、水印\n[参考图] 风格参考 ×1，后附 1 张为品牌风格参考，不作为画面主体\n—— 用户提示词 ——\n商品摄影");
  expect(result.referenceKeys).toEqual(["first"]);
  expect(result.endpoint).toBe("images/edits");
  expect(result.instructions).not.toContain("商品摄影");
  expect(JSON.stringify(brand)).toBe(snapshot);
  expect(injectBrand({ brand, prompt: "原图", capability: "image", supportsEdit: true, maxReferenceImages: 1, originalReferenceCount: 1, endpoint: "images/edits" }).referenceKeys).toEqual([]);
});

test("无品牌保留原请求，非编辑模型与文本视频音频不携带品牌参考图", () => {
  expect(injectBrand({ prompt: "原文", capability: "image" })).toEqual({ text: "原文", instructions: "", referenceKeys: [], endpoint: "images/generations" });
  expect(injectBrand({ brand, prompt: "原文", capability: "image", supportsEdit: false }).endpoint).toBe("images/generations");
  for (const capability of ["text", "video", "audio"] as const) {
    const result = injectBrand({ brand, prompt: "原文", capability, supportsEdit: true });
    expect(result.referenceKeys).toEqual([]); expect(result.text).not.toContain("[参考图]");
  }
});

test("none只跳过非强制默认品牌，显式品牌与默认品牌各自确定", () => {
  expect(selectBrandId(undefined)).toBeNull();
  expect(selectBrandId(undefined, { id: "default", enforced: false })).toBe("default");
  expect(selectBrandId("none", { id: "default", enforced: false })).toBeNull();
  expect(selectBrandId("none", { id: "default", enforced: true })).toBe("default");
  expect(selectBrandId("explicit", { id: "default", enforced: true })).toBe("explicit");
});

test("品牌默认参数仅补缺失业务字段，不覆盖调用者参数或注入连接凭据", () => {
  const defaults = { model: "image", n: 3, size: "1024x1024", voice: "alloy", apiKey: "private", baseUrl: "https://wrong.test", seconds: 4 };
  expect(applyBrandDefaults(defaults, { n: 1, prompt: "用户提示词" }, "image")).toEqual({ model: "image", n: 1, size: "1024x1024", prompt: "用户提示词" });
  expect(applyBrandDefaults(defaults, { model: "audio" }, "audio")).toEqual({ model: "audio", voice: "alloy" });
  expect(applyBrandDefaults(defaults, { seconds: 0 }, "video").seconds).toBe(0);
});

test("成熟图片解析器提取尺寸并拒绝截断文件及MIME伪装", () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV6kAAAAASUVORK5CYII=", "base64");
  expect(validateImageBytes(bytes, "image/png")).toEqual({ width: 1, height: 1, mimeType: "image/png" });
  expect(() => validateImageBytes(bytes, "image/jpeg")).toThrow();
  expect(() => validateImageBytes(bytes.subarray(0, 12), "image/png")).toThrow();
});
