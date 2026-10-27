import type { AiConfig } from "@/stores/use-config-store";
import type { BrandRules } from "@/services/api/platform/brands";
import { injectBrand } from "../../../shared/brand-inject";
import i18n from "@/i18n";

export function brandDefaultsToConfig(params: Record<string, unknown>, config?: AiConfig): Partial<AiConfig> {
    const fields: Record<string, keyof AiConfig> = { quality: "quality", size: "size", n: "count", background: "background", seconds: "videoSeconds", resolution: "vquality", generate_audio: "videoGenerateAudio", watermark: "videoWatermark", mode: "videoMode", voice: "audioVoice", speed: "audioSpeed", response_format: "audioFormat" };
    const result = Object.fromEntries(Object.entries(fields).filter(([key]) => params[key] !== undefined && ["string", "number", "boolean"].includes(typeof params[key])).map(([key, field]) => [field, String(params[key])])) as Partial<AiConfig>;
    if (params.n !== undefined) result.canvasImageCount = String(params.n);
    if (params.aspect_ratio !== undefined && params.size === undefined) result.size = String(params.aspect_ratio);
    if (typeof params.temperature === "number") result.temperature = params.temperature;
    if (typeof params.max_output_tokens === "number") result.maxOutputTokens = params.max_output_tokens;
    if (typeof params.model === "string" && config) {
        const channel = config.channels.find((channel) => channel.models.some((model) => model.name === params.model));
        const model = channel?.models.find((model) => model.name === params.model);
        if (channel && model) { const value = `${channel.id}::${model.name}`; result.model = value; result[`${model.capability}Model`] = value; }
    }
    return result;
}
export function effectiveBrand(context: AiConfig["platformContext"], enabled = context?.brandKit !== false): BrandRules | undefined {
    if (enabled || context?.brand?.enforced) return context?.brand;
    return context?.defaultBrand?.enforced ? context.defaultBrand : undefined;
}
export function applyBrandConfigDefaults(config: AiConfig, brand?: BrandRules | null, overrides: Partial<AiConfig> = {}) {
    return brand ? { ...config, ...brandDefaultsToConfig(brand.defaultParams, config), ...overrides } : config;
}
export function applyByokBrand(config: AiConfig): AiConfig {
    if (!config.platformContext) return config;
    if (config.platformContext.brandReady === false) throw new Error(i18n.t("platform.brandNotReady"));
    const brand = effectiveBrand(config.platformContext);
    if (!brand) return config;
    const instructions = injectBrand({ brand, prompt: "", capability: "text" }).instructions;
    return { ...config, brandInstructions: instructions, systemPrompt: [instructions, config.systemPrompt.trim()].filter(Boolean).join("\n\n") };
}
