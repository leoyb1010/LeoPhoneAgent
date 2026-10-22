import type { McpToolDescriptor } from "./mcpHttpEndpoint.js";
import { PROFILE_CARD_TITLE } from "./profileCard.js";

/**
 * [leo] 第二大脑九个工具的 MCP 定义(实现在 brainTools.ts)。
 *
 * 每个工具在 tools/list 的 `_meta.timeoutMs` 里声明总时限:CLI 读它当这个工具的等待上限
 * (apps/zcode-cli/packages/adapters/src/mcp/descriptor.ts),不声明就只等 30 s,
 * 比网关上搜索 / 读原文 / 问答 / 上传要的时间短。
 */

type Json = Record<string, unknown>;

const REF = { type: "string", description: "结果里的 ref，例如 file:ab12…、card:…、memory:…" };

// [名字, 描述, 参数, 必填, CLI 侧总时限 ms]
const TOOL_DEFS: Array<[string, string, Json, string[], number]> = [
  [
    "brain_brief",
    "返回本 key 的权限、资料规模与推荐用法（纯文本）。平时不用先调它，直接 brain_search。",
    {},
    [],
    45_000,
  ],
  [
    "brain_search",
    "检索 Leo 的第二大脑：他自己的文档、知识卡、日页、项目报告、过往决定、照片视频和记忆。问题涉及 Leo 本人、他的项目、之前的工作或决定、他生活里的人，或说到「我的/之前/上次/记得/笔记/资料/大脑」时先用它。返回紧凑结果（标题/日期/摘要/定位/web_url/缩略图链接），按类型分组；要细节再 brain_read。",
    {
      query: { type: "string" },
      include_private: { type: "boolean", description: "包含私密资料（家庭照片、个人记录）" },
      kind: { type: "string", enum: ["all", "document", "card", "image", "video"] },
      limit: { type: "integer", default: 12 },
      offset: { type: "integer", default: 0 },
      group: { type: "boolean", default: true },
    },
    ["query"],
    45_000,
  ],
  [
    "brain_media_search",
    "用自然语言找 Leo 的照片或视频（人物、时间、地点、场景，如「去年夏天布布在海边」）。返回理解后的条件和紧凑结果，含签名缩略图/播放链接。",
    {
      query: { type: "string" },
      kind: { type: "string", enum: ["all", "photo", "video"] },
      year: { type: "string" },
      limit: { type: "integer", default: 12 },
      offset: { type: "integer", default: 0 },
    },
    ["query"],
    45_000,
  ],
  [
    "brain_read",
    "读 brain_search 结果里一份资料或知识卡的原文片段（按 locator 定位，带分页）；回答时注明标题。",
    {
      ref: REF,
      locator: { type: "string" },
      offset: { type: "integer", default: 0 },
      max_chars: { type: "integer", default: 6000 },
    },
    ["ref"],
    45_000,
  ],
  [
    "brain_media_get",
    "取一张照片或一段视频的详情：Gemini 描述、标签、画面分段、语音转写、可打开的链接；include_image=true 时附带缩略图供看图。",
    {
      ref: REF,
      include_image: { type: "boolean", default: false },
      segments_offset: { type: "integer", default: 0 },
    },
    ["ref"],
    60_000,
  ],
  [
    "brain_link",
    "为资料生成可直接在手机/浏览器打开的签名链接；variant: thumb/preview（24h）、video（6h）、raw 原件（1h）、web 网页深链。",
    {
      refs: { type: "array", items: { type: "string" } },
      variant: { type: "string", enum: ["thumb", "preview", "video", "raw", "web"] },
      ttl_hours: { type: "number" },
    },
    ["refs"],
    45_000,
  ],
  [
    "brain_ask",
    "基于原文证据回答需要综合多份资料的问题（每个结论带 [n] 引用与 web_url）；只是找资料用 brain_search 更快。最多等 wait_seconds（上限 45）；没完成会返回 id，再传 id 继续等。",
    {
      question: { type: "string" },
      id: { type: "string", description: "继续等待之前的回答" },
      include_private: { type: "boolean" },
      mode: { type: "string", enum: ["answer", "analyze", "prepare"] },
      refs: { type: "array", items: { type: "string" } },
      wait_seconds: { type: "integer", default: 25 },
    },
    [],
    60_000,
  ],
  [
    "brain_save_card",
    `把结论存成草稿知识卡（不会自动确认，Leo 会在审阅队列里看）。标题「${PROFILE_CARD_TITLE}」留给 iPhone 维护的用户画像，不能用。`,
    {
      title: { type: "string" },
      body: { type: "string" },
      sources: {
        type: "array",
        items: {
          type: "object",
          properties: { ref: { type: "string" }, locator: { type: "string" } },
        },
      },
      category: { type: "string" },
      idempotency_key: { type: "string" },
    },
    ["title", "body"],
    45_000,
  ],
  [
    "brain_upload",
    "把本机一个文件存进第二大脑收件箱（自动解析、向量化、提炼；相同内容不重复保存）。",
    {
      path: {
        type: "string",
        description: "本机文件路径；最好用绝对路径，相对路径按当前工作区解析",
      },
      name: { type: "string" },
      idempotency_key: { type: "string" },
    },
    ["path"],
    330_000,
  ],
];

export const BRAIN_TOOLS: readonly McpToolDescriptor[] = TOOL_DEFS.map(
  ([name, description, properties, required, timeoutMs]) => ({
    name,
    description,
    inputSchema: { type: "object", properties, required },
    _meta: { timeoutMs },
  }),
);
export const TOOL_BUDGET_MS: ReadonlyMap<string, number> = new Map(
  TOOL_DEFS.map(([name, , , , timeoutMs]) => [name, timeoutMs]),
);
