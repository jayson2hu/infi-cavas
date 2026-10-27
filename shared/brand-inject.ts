export type BrandCapability = "image" | "video" | "text" | "audio";
export type BrandKit = {
  name: string;
  requiredTerms: string[];
  avoidTerms: string[];
  colors: Array<{ name: string; hex: string; sort?: number }>;
  assets?: Array<{ kind: string; attachOnGenerate: boolean; objectKey?: string; sort?: number }>;
};
export type BrandInjectionInput = {
  brand?: BrandKit | null;
  prompt: string;
  capability: BrandCapability;
  supportsEdit?: boolean;
  maxReferenceImages?: number;
  originalReferenceCount?: number;
  endpoint?: string;
};

export function injectBrand(input: BrandInjectionInput) {
  const endpoint = input.endpoint ?? ({ image: "images/generations", text: "responses", video: "videos", audio: "audio/speech" } as const)[input.capability];
  if (!input.brand) return { text: input.prompt, instructions: "", referenceKeys: [] as string[], endpoint };
  const { brand } = input;
  const capacity = Math.max(0, (input.maxReferenceImages ?? 8) - (input.originalReferenceCount ?? 0));
  const referenceKeys = input.capability === "image" && input.supportsEdit
    ? (brand.assets ?? []).filter((asset) => asset.kind === "style_ref" && asset.attachOnGenerate && asset.objectKey).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)).slice(0, capacity).map((asset) => asset.objectKey!) : [];
  const instructions = [
    `[品牌] ${brand.name}`,
    `[风格] ${brand.requiredTerms.join("，")}`,
    `[色彩] ${[...brand.colors].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)).map((color) => `${color.name} ${color.hex}`).join("，")}`,
    `[避免] ${brand.avoidTerms.join("、")}`,
    ...(referenceKeys.length ? [`[参考图] 风格参考 ×${referenceKeys.length}，后附 ${referenceKeys.length} 张为品牌风格参考，不作为画面主体`] : []),
  ].join("\n");
  return { text: `${instructions}\n—— 用户提示词 ——\n${input.prompt}`, instructions, referenceKeys, endpoint: referenceKeys.length && endpoint === "images/generations" ? "images/edits" : endpoint };
}

export function selectBrandId(requested: string | undefined, defaultBrand?: { id: string; enforced: boolean } | null) {
  if (requested === "none") return defaultBrand?.enforced ? defaultBrand.id : null;
  return requested || defaultBrand?.id || null;
}

const defaultKeys: Record<BrandCapability, string[]> = {
  image: ["model", "quality", "size", "n", "background"],
  video: ["model", "seconds", "size", "quality", "resolution", "aspect_ratio", "generate_audio", "watermark", "mode"],
  audio: ["model", "voice", "speed", "response_format"],
  text: ["model", "temperature", "max_output_tokens"],
};
export function applyBrandDefaults(defaults: Record<string, unknown>, params: Record<string, unknown>, capability: BrandCapability) {
  return { ...Object.fromEntries(defaultKeys[capability].filter((key) => defaults[key] !== undefined).map((key) => [key, defaults[key]])), ...params };
}
