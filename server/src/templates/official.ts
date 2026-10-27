import { inArray } from "drizzle-orm";
import example from "../../../specs/template-example.json";
import type { TemplateBody, TemplateConnectOp, TemplateMode, TemplateNodeOp, TemplateVariable } from "../../../shared/template";
import { db, type Transaction } from "../db/client";
import { pricingRules, templates } from "../db/schema";
import { estimate } from "../gateway/pricing";
import { invariant } from "../lib/errors";
import { validateTemplateBody } from "./validation";

const modelIds: Record<TemplateMode, string> = { image: "gpt-image-2", text: "gpt-5.5", video: "sora-2", audio: "gpt-4o-mini-tts" };
const node = (id: string, nodeType: string, title: string, x: number, y: number, metadata: Record<string, unknown> = {}): TemplateNodeOp => ({ type: "add_node", id, nodeType, title, x, y, width: 280, height: nodeType === "text" ? 180 : nodeType === "audio" ? 100 : 280, metadata });
const generated = (id: string, mode: TemplateMode, title: string, x: number, y: number, prompt: string, extra: Record<string, unknown> = {}) => node(id, mode, title, x, y, { generationMode: mode, model: modelIds[mode], prompt, ...(mode === "image" ? { count: 1, size: "1024x1024" } : {}), ...extra });
const connect = (fromNodeId: string, toNodeId: string): TemplateConnectOp => ({ type: "connect_nodes", fromNodeId, toNodeId });
const imageVariable: TemplateVariable = { key: "product", label: "产品图片", type: "image", bindNode: "product", required: true, allowBrandSku: true, placeholder: "上传产品图，或从品牌SKU中选择" };
const textVariable = (key: string, label: string): TemplateVariable => ({ key, label, type: "text", required: true });
const product = () => node("product", "image", "产品图片", 0, 0);
const brief = (content: string) => node("brief", "text", "创作需求", 0, 330, { content });
type OfficialTemplate = { id: string; name: string; category: string; description: string; previewNodes: string[]; body: TemplateBody };

export const officialTemplateDefinitions: OfficialTemplate[] = [
  { id: example.id, name: example.name, category: example.category, description: example.description, previewNodes: example.preview_nodes, body: example.body as TemplateBody },
  {
    id: "tpl_product_detail_long", name: "商品详情页长图", category: "ecommerce", description: "整理商品卖点，生成三块详情素材，再合成长版商品详情图。", previewNodes: ["商品图", "卖点与板块", "详情长图"],
    body: { version: 1, variables: [imageVariable, textVariable("productName", "商品名称"), textVariable("sellingPoints", "商品卖点与参数")],
      ops: [product(), brief("商品名称：{{var.productName}}\n卖点与参数：{{var.sellingPoints}}"),
        generated("copy", "text", "详情页文案结构", 360, 0, "根据商品图片和需求，输出商品详情页的首屏主张、核心优势、参数说明三个板块的中文文案。不要编造输入中没有的参数。"),
        generated("hero", "image", "首屏主视觉", 740, -100, "为{{var.productName}}制作商品详情首屏。严格保持参考商品外观，围绕首屏主张呈现产品与标题，简洁电商设计。", { size: "1024x1536" }),
        generated("benefits", "image", "核心优势板块", 740, 240, "为{{var.productName}}制作核心优势详情板块，基于已给出的卖点和文案进行图文排版，保持参考商品与品牌风格一致。", { size: "1024x1536" }),
        generated("specs", "image", "参数说明板块", 740, 580, "为{{var.productName}}制作参数说明板块，只使用需求和文案中提供的事实，版面清楚，商品外观与参考一致。", { size: "1024x1536" }),
        generated("long", "image", "商品详情页长图", 1120, 180, "将参考的首屏、优势、参数三个板块按顺序整合为一张完整商品详情长图。统一背景、字体和品牌配色，保持产品外观和参数不变，衔接自然。", { size: "1024x3072" }),
        connect("product", "copy"), connect("brief", "copy"),
        ...["hero", "benefits", "specs"].flatMap((id) => [connect("product", id), connect("copy", id)]), ...["hero", "benefits", "specs"].map((id) => connect(id, "long"))],
      steps: [{ label: "梳理详情文案", nodeIds: ["copy"], mode: "text" }, { label: "生成三个详情板块", nodeIds: ["hero", "benefits", "specs"], mode: "image" }, { label: "整合详情长图", nodeIds: ["long"], mode: "image" }] },
  },
  {
    id: "tpl_short_video_storyboard", name: "短视频分镜", category: "short_video", description: "从主题与产品图生成分镜文案、三张分镜图、三段短片和配套旁白。", previewNodes: ["产品与主题", "分镜与短片", "旁白"],
    body: { version: 1, variables: [imageVariable, textVariable("subject", "短视频主题与卖点")],
      ops: [product(), brief("视频主题：{{var.subject}}"),
        generated("script", "text", "三镜头分镜脚本", 360, -120, "根据产品与主题设计三个连续的短视频镜头，每镜头4秒。分别描述开场、产品细节、收束展示，保持产品外观，不添加未经提供的功效。"),
        generated("narration", "text", "旁白文案", 360, 250, "为{{var.subject}}撰写适合12秒产品短片的简短中文旁白。只输出可直接朗读的正文，不要标题或镜头编号。"),
        ...[1, 2, 3].map((shot) => generated(`frame${shot}`, "image", `分镜 ${shot}`, 740, (shot - 1) * 340 - 120, `根据脚本的第${shot}个镜头生成竖版分镜画面。保持参考商品外观、包装与颜色一致，画面风格连续。`, { size: "1088x1920" })),
        ...[1, 2, 3].map((shot) => generated(`clip${shot}`, "video", `短片 ${shot}`, 1120, (shot - 1) * 340 - 120, `以参考分镜为起始画面完成第${shot}个4秒镜头，运动自然，保持产品结构，不增加多余物体或水印。`, { seconds: "4", size: "720x1280", videoMode: "frames" })),
        generated("voice", "audio", "配套旁白", 1120, 940, "{{var.subject}}", { audioVoice: "alloy", audioFormat: "mp3", audioSpeed: "1" }),
        connect("product", "script"), connect("brief", "script"), connect("brief", "narration"),
        ...[1, 2, 3].flatMap((shot) => [connect("product", `frame${shot}`), connect("script", `frame${shot}`), connect(`frame${shot}`, `clip${shot}`)]), connect("narration", "voice")],
      steps: [{ label: "分镜与旁白文案", nodeIds: ["script", "narration"], mode: "text" }, { label: "三张分镜图", nodeIds: ["frame1", "frame2", "frame3"], mode: "image" }, { label: "三段4秒短片", nodeIds: ["clip1", "clip2", "clip3"], mode: "video" }, { label: "旁白配音", nodeIds: ["voice"], mode: "audio" }] },
  },
  {
    id: "tpl_brand_campaign_poster", name: "品牌活动海报", category: "brand", description: "梳理活动文案，按当前品牌规范生成竖版主海报与横版宣传图。", previewNodes: ["活动信息", "海报文案", "双尺寸海报"],
    body: { version: 1, variables: [textVariable("campaign", "活动主题"), textVariable("details", "活动时间、地点与权益")],
      ops: [brief("主题：{{var.campaign}}\n活动信息：{{var.details}}"), generated("copy", "text", "海报文案", 360, 0, "把活动信息整理为海报主标题、副标题、时间地点和行动引导。只使用已提供的事实，保持简短。"),
        generated("poster", "image", "竖版主海报", 740, -80, "围绕{{var.campaign}}设计品牌活动竖版主海报，按参考文案呈现信息层级，使用品牌颜色和风格，留白清楚。", { size: "1024x1536" }),
        generated("banner", "image", "横版宣传图", 740, 340, "围绕{{var.campaign}}设计品牌活动横版宣传图，与主海报概念保持统一，突出主标题和行动引导。", { size: "1536x1024" }), connect("brief", "copy"), connect("copy", "poster"), connect("copy", "banner")],
      steps: [{ label: "整理活动文案", nodeIds: ["copy"], mode: "text" }, { label: "生成双尺寸海报", nodeIds: ["poster", "banner"], mode: "image" }] },
  },
  {
    id: "tpl_social_xhs_set", name: "小红书种草组图", category: "social", description: "根据产品和使用体验生成种草文案，以及封面、体验、总结三张组图。", previewNodes: ["产品图", "种草文案", "封面与内页"],
    body: { version: 1, variables: [imageVariable, textVariable("experience", "产品亮点与真实使用体验")],
      ops: [product(), brief("产品亮点与体验：{{var.experience}}"), generated("copy", "text", "种草文案", 360, 0, "根据输入的真实使用体验整理小红书图文内容，给出封面标题、体验要点、总结建议。不编造使用经历或效果。"),
        generated("cover", "image", "种草封面", 740, -100, "结合参考产品与文案制作小红书封面，主体清晰，突出一个核心亮点，简洁标题，与品牌风格一致。", { size: "1248x1664" }),
        generated("experience", "image", "体验内页", 740, 250, "结合参考产品和文案制作体验内页，围绕真实使用要点安排图文，保持产品外观准确和阅读节奏清楚。", { size: "1248x1664" }),
        generated("summary", "image", "总结内页", 740, 600, "结合参考产品和文案制作总结内页，突出适用场景与建议，保持组图配色、字体和产品外观一致。", { size: "1248x1664" }),
        connect("product", "copy"), connect("brief", "copy"), ...["cover", "experience", "summary"].flatMap((id) => [connect("product", id), connect("copy", id)])],
      steps: [{ label: "整理种草文案", nodeIds: ["copy"], mode: "text" }, { label: "封面与两张内页", nodeIds: ["cover", "experience", "summary"], mode: "image" }] },
  },
  {
    id: "tpl_store_materials", name: "门店物料延展", category: "other", description: "将门店活动信息延展为门店海报、台卡和宣传横幅，保持统一品牌视觉。", previewNodes: ["门店活动", "物料文案", "三种物料"],
    body: { version: 1, variables: [textVariable("store", "门店名称"), textVariable("activity", "活动信息与使用场景")],
      ops: [brief("门店：{{var.store}}\n活动与场景：{{var.activity}}"), generated("copy", "text", "门店物料文案", 360, 0, "为门店活动整理宣传标题、核心权益和使用提示，分别给出海报、台卡、横幅所需的简短文案。不添加未提供的地址、价格或日期。"),
        generated("poster", "image", "门店海报", 740, -100, "为{{var.store}}设计门店活动海报，遵循品牌配色和参考文案，突出主要活动信息与清晰行动引导。", { size: "1024x1536" }),
        generated("card", "image", "桌面台卡", 740, 260, "为{{var.store}}设计横版桌面台卡，聚焦核心权益，字级清楚，适合近距离阅读，与活动海报风格统一。", { size: "1536x1024" }),
        generated("banner", "image", "宣传横幅", 740, 620, "为{{var.store}}设计活动宣传横幅，减少文字，突出主标题与活动权益，远距离也能看清，保持品牌一致。", { size: "2048x1024" }),
        connect("brief", "copy"), ...["poster", "card", "banner"].map((id) => connect("copy", id))],
      steps: [{ label: "整理门店文案", nodeIds: ["copy"], mode: "text" }, { label: "海报、台卡与横幅", nodeIds: ["poster", "card", "banner"], mode: "image" }] },
  },
];

export async function seedOfficialTemplates(client: typeof db | Transaction = db) {
  const rules = new Map((await client.select().from(pricingRules)).map((rule) => [rule.modelId, rule]));
  for (const definition of officialTemplateDefinitions) {
    const body = structuredClone(definition.body);
    for (const step of body.steps) step.estimate = step.nodeIds.reduce((sum, nodeId) => {
      const op = body.ops.find((op): op is TemplateNodeOp => op.type === "add_node" && op.id === nodeId)!;
      const metadata = op.metadata ?? {};
      const modelId = typeof metadata.model === "string" ? metadata.model : modelIds[step.mode];
      const rule = rules.get(modelId);
      invariant(rule, 503, "template_pricing_unavailable", `官方模板模型 ${modelId} 尚未配置定价`);
      const size = metadata.size === "1:1" ? "1024x1024" : metadata.size;
      const params = { n: metadata.count ?? 1, size, seconds: metadata.seconds, input: String(metadata.prompt ?? "") };
      return sum + estimate(rule, params) * (step.mode === "text" ? Number(metadata.textCount ?? 1) : 1);
    }, 0);
    validateTemplateBody(body);
    await client.insert(templates).values({ ...definition, body, workspaceId: null, estimateCredits: body.steps.reduce((sum, step) => sum + (step.estimate ?? 0), 0) }).onConflictDoNothing();
  }
  return client.select().from(templates).where(inArray(templates.id, officialTemplateDefinitions.map((template) => template.id)));
}
