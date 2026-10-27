import { db, sqlClient } from "./client";
import { models, plans, pricingRules } from "./schema";
import { seedOfficialTemplates } from "../templates/official";

// These are editable defaults from the delivery specification, not configured providers.
// A model is only listed by the gateway after an administrator adds an active route.
export async function seedDatabase() {
  await db.transaction(async (tx) => {
    await tx.insert(models).values([
      { id: "gpt-image-2", displayName: "GPT Image 2", capability: "image", supportsEdit: true, sort: 10 },
      { id: "sora-2", displayName: "Sora 2", capability: "video", sort: 20 },
      { id: "gpt-5.5", displayName: "GPT-5.5", capability: "text", sort: 30 },
      { id: "gpt-4o-mini-tts", displayName: "TTS", capability: "audio", sort: 40 },
    ]).onConflictDoNothing();
    await tx.insert(pricingRules).values([
      { modelId: "gpt-image-2", unit: "per_image", config: { standard: 4, hd: 8 } },
      { modelId: "sora-2", unit: "per_second", config: { price: 12 } },
      { modelId: "gpt-5.5", unit: "per_1k_tokens", config: { input: 0.5, output: 2, hold: 10, min: 1 } },
      { modelId: "gpt-4o-mini-tts", unit: "per_1k_chars", config: { price: 2 } },
    ]).onConflictDoNothing();
    // 套餐目录默认值，价格与额度待运营确认，管理员可在后台修改；已存在的套餐不覆盖。
    await tx.insert(plans).values([
      { id: "free", name: "免费版", monthlyCredits: 0, priceText: "免费", description: "注册赠送点数，按需兑换充值", sort: 10 },
      { id: "team", name: "团队版", monthlyCredits: 10000, priceText: "[价格待定]", description: "每月发放订阅点数，适合小团队日常出图", sort: 20 },
      { id: "enterprise", name: "企业版", monthlyCredits: 50000, priceText: "[联系销售]", description: "更高月度额度与专属支持", sort: 30 },
    ]).onConflictDoNothing();
    await seedOfficialTemplates(tx);
  });
}

if (import.meta.main) {
  try { await seedDatabase(); } finally { await sqlClient.end(); }
}
