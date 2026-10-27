import Decimal from "decimal.js";
import i18n from "@/i18n";
import { clampVideoSeconds, imageSizePresets, parsePixelSize } from "@/lib/media-size";
import { decodeChannelModel, type AiConfig } from "@/stores/use-config-store";
import type { PriceRule } from "@/services/api/platform/types";

const ExactDecimal = Decimal.clone({ precision: 400 });
export function modelPriceRule(config: AiConfig, value = config.model) {
    const model = decodeChannelModel(value);
    return model?.channelId === "platform" ? config.channels.find((channel) => channel.id === model.channelId)?.models.find((item) => item.name === model.model)?.priceHint : undefined;
}
export function estimateDisplayCredits(rule: PriceRule, params: { n?: number; size?: string; seconds?: number; input?: string }) {
    let value: Decimal;
    if (rule.unit === "per_image") {
        const size = imageSizePresets["1k"][params.size || ""] || params.size || "auto";
        const pixels = parsePixelSize(size);
        if (!pixels && size !== "auto") return null;
        const price = pixels && Math.max(pixels.width, pixels.height) > 1536 ? rule.config.hd : rule.config.standard;
        value = new ExactDecimal(price).times(params.n ?? 1);
    } else if (rule.unit === "per_second") {
        if (params.seconds === undefined) return null;
        value = new ExactDecimal(rule.config.price).times(params.seconds);
    } else if (rule.unit === "per_1k_tokens") value = new ExactDecimal(rule.config.hold);
    else {
        if (params.input === undefined) return null;
        value = new ExactDecimal(rule.config.price).times(Array.from(params.input).length).div(1000);
    }
    return value.isFinite() && value.gte(0) && value.lte(2147483647) ? value.ceil().toNumber() : null;
}
export function estimateConfigCredits(config: AiConfig, input?: string) {
    const rule = modelPriceRule(config);
    return rule ? estimateDisplayCredits(rule, { n: Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1))), size: config.size, seconds: Number(clampVideoSeconds(config.videoSeconds)), input }) : null;
}
export function formatPriceHint(rule: PriceRule) {
    return i18n.t(`platform.pricing.${rule.unit}`, rule.config);
}
