import { db, sqlClient } from "./client";
import { models, pricingRules } from "./schema";
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
    await seedOfficialTemplates(tx);
  });
}

if (import.meta.main) {
  try { await seedDatabase(); } finally { await sqlClient.end(); }
}
