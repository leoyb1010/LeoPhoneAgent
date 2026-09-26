/**
 * 本机 Agent 的纯文本逻辑:压缩、起标题、中断续跑、技能索引、MCP 报文、搜索结果、定时任务到点、完成通知。
 * 提示词沿用 iOS 原文(AIChatViewModel+Compaction / +TitleGeneration),行为对齐 iOS / 安卓。
 * 这里不 import 任何东西:protocol/agentText.ts 是它的逐字镜像,protocol.test.mjs 会比对。
 */

/** 纯函数看到的一条消息(会话里的 LocalChatMessage 转过来)。kind:'' 普通;summary 压缩摘要;resume 继续;partial 停下时没说完的回答。 */
export class TextLine {
  role: string = '';
  text: string = '';
  kind: string = '';
}

// ---- 工具行:存档里怎么记工具,续跑和压缩都按这两个前缀认 ----

export const TOOL_PLAN_PREFIX: string = '将调用工具:';
export const TOOL_RESULT_PREFIX: string = '工具 ';

export function toolPlanLine(names: string[]): string {
  return `${TOOL_PLAN_PREFIX}${names.join('、')}`;
}

export function toolResultLine(name: string, text: string): string {
  return `${TOOL_RESULT_PREFIX}${name}: ${text}`;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.substring(0, max)}…` : text;
}

export function lastSummaryIndex(lines: TextLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].kind === 'summary') {
      return i;
    }
  }
  return -1;
}

/** 随消息附上的文件清单(iOS、安卓的 <user-attached-files> 写法;模型自己用 file_read / read_image 读)。 */
export function attachedFilesBlock(names: string[]): string {
  if (names.length === 0) {
    return '';
  }
  const rows = names.map((name: string) => `  <file path="${name}" />`);
  return `<user-attached-files>\n${rows.join('\n')}\n</user-attached-files>`;
}

// ---- 压缩(iOS AIChatViewModel+Compaction 同一套提示词) ----

export const COMPACT_KEEP_USER_TURNS: number = 3;
/** 最后一个摘要之后的对话超过这么多字,发送前自动压缩(发给模型的上限是 6 万字,留出余量)。 */
export const COMPACT_AT_CHARS: number = 48000;
const TRANSCRIPT_LINE_CAP: number = 2000;
const TRANSCRIPT_RESULT_CAP: number = 500;
// ponytail: 太长只留最后 12 万字,不像 iOS 那样对半拆开分别摘要再合并;真碰到再加。
const TRANSCRIPT_TOTAL_CAP: number = 120000;

export const COMPACT_SYSTEM_PROMPT: string =
  'You are a context compaction engine. Your summary will REPLACE the original messages in the conversation ' +
  'context window. The agent will read your summary as past context, then proceed based on the user\'s NEXT ' +
  'message — your summary is background, not a standing work order. Write the summary in the same language the ' +
  'user used in the conversation.\n\n' +
  'MUST PRESERVE (never omit or shorten):\n' +
  '- All file paths, directory names, URLs, UUIDs, and identifiers — copy verbatim\n' +
  '- Commands executed and their outcomes (success/failure/output)\n' +
  '- What was requested and what was done (record as past events, not as ongoing goals)\n' +
  '- Key decisions made and their rationale\n' +
  '- Errors encountered and how they were resolved\n' +
  '- Important constraints, rules, or user preferences mentioned\n' +
  '- Any tool calls and their results that affect current state\n\n' +
  'STRUCTURE:\n' +
  '1. Start with a one-line description of what the conversation was about (use past tense — "User asked X, ' +
  'agent did Y", NOT "Goal: X").\n' +
  '2. Then a concise narrative of what happened, preserving technical details.\n' +
  '3. End with a "What had been done so far" section listing completed work — NOT a "todo" or "pending" list. ' +
  'Do not invent ongoing objectives or carry-over tasks from old turns; if the user wants to continue, they will ' +
  'say so in their next message.\n\n' +
  'PRIORITIZE recent context over older history — recent decisions and recent file/path references are most ' +
  'useful for continuity.\n\n' +
  'Do NOT translate or alter code snippets, file paths, identifiers, or error messages. Be concise but never ' +
  'lose information the agent needs.';

export function compactUserMessage(conversation: string): string {
  return `Compact this conversation into a context summary:\n\n${conversation}\n\n---\nEND OF CONVERSATION TO COMPACT.\n\n` +
    'Now generate a structured context summary following the system prompt instructions. Do NOT continue the ' +
    'conversation above — summarize it. Write everything in past tense, framed as "what was discussed / what was ' +
    'done", NOT as an ongoing goal or todo list.';
}

/** 交给模型写摘要的对话稿:[User] / [Assistant] / [Tool] / [Result],已有摘要时合并进去。 */
export function compactTranscript(lines: TextLine[], previousSummary: string): string {
  const rows: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.text.trim();
    if (text.length === 0 || line.kind === 'summary') {
      continue;
    }
    if (line.role === 'user') {
      rows.push(`[User] ${cut(line.kind === 'resume' ? '继续' : text, TRANSCRIPT_LINE_CAP)}`);
    } else if (line.role === 'assistant') {
      rows.push(`[Assistant] ${cut(text, TRANSCRIPT_LINE_CAP)}`);
    } else if (text.startsWith(TOOL_PLAN_PREFIX)) {
      rows.push(`[Tool] ${text.substring(TOOL_PLAN_PREFIX.length)}`);
    } else if (text.startsWith(TOOL_RESULT_PREFIX)) {
      rows.push(`[Result] ${cut(text.substring(TOOL_RESULT_PREFIX.length), TRANSCRIPT_RESULT_CAP)}`);
    }
  }
  let body = rows.join('\n');
  if (body.length > TRANSCRIPT_TOTAL_CAP) {
    body = body.substring(body.length - TRANSCRIPT_TOTAL_CAP);
  }
  const prev = previousSummary.trim();
  return prev.length > 0 ? `Previous context summary:\n${prev}\n\nNew conversation to merge:\n${body}` : body;
}

/**
 * 压缩的分界:最后一个摘要之后,从倒数第 keep 个用户消息起原样保留,前面的交给模型写摘要。
 * 分界前没有东西可压时返回 -1。
 */
export function compactCut(lines: TextLine[], keep: number): number {
  const start = lastSummaryIndex(lines) + 1;
  let seen = 0;
  for (let i = lines.length - 1; i >= start; i--) {
    if (lines[i].role === 'user' && lines[i].kind === '') {
      seen += 1;
      if (seen === keep) {
        return i > start ? i : -1;
      }
    }
  }
  return -1;
}

/** 最后一个摘要之后,用户和模型说了多少字(决定要不要自动压缩)。 */
export function historyChars(lines: TextLine[]): number {
  let total = 0;
  for (let i = lastSummaryIndex(lines) + 1; i < lines.length; i++) {
    if (lines[i].role === 'user' || lines[i].role === 'assistant') {
      total += lines[i].text.length;
    }
  }
  return total;
}

/** 摘要放进摘要之后的第一句用户消息前面(iOS / 安卓同一段话)。 */
export function summaryWrapper(summary: string): string {
  return '<context-summary>\n' +
    'The following is a summary of the earlier conversation that was compacted to save context space.\n' +
    'Treat it as background context only. The user\'s most recent message (below or in the next turn) takes ' +
    'precedence — if it changes the task, the goal, or any numbers/scope, follow the new instruction and do not ' +
    'resume the old plan from this summary. Do not re-run discovery (reading memory, scanning skills, re-reading ' +
    'files) unless the new instruction requires it.\n\n' +
    `${summary.trim()}\n</context-summary>`;
}

// ---- 起标题(iOS AIChatViewModel+TitleGeneration 同一套提示词) ----

export const TITLE_SYSTEM_PROMPT: string = 'You generate concise titles for conversations. You MUST respond with a ' +
  'single valid JSON object: {"title": "...", "category": "..."}. No other text.';
const TITLE_LANGUAGE: string = 'The user\'s app interface language is "zh-Hans" (中文（简体）). Generate the title ' +
  'primarily in this language. If the conversation content is in a different language, you may incorporate proper ' +
  'nouns from it, but the overall title language should match the interface language.\n' +
  '用户的 App 界面语言是 "zh-Hans"（中文（简体））。请优先使用该语言生成标题。如果对话内容是其他语言，可保留专有名词，' +
  '但标题整体语言应与界面语言一致。';
/** 每个对话最多试几次(和 iOS、安卓一样)。 */
export const TITLE_ATTEMPTS: number = 3;

/** 第一句用户的话 + 第一段回答(各 200 字);不止一轮时再加最后一轮。没有回答时返回空。 */
export function titleExcerpt(lines: TextLine[]): string {
  const users: string[] = [];
  const answers: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text.trim();
    if (text.length === 0 || lines[i].kind !== '') {
      continue;
    }
    if (lines[i].role === 'user') {
      users.push(text);
    } else if (lines[i].role === 'assistant') {
      answers.push(text);
    }
  }
  if (users.length === 0 || answers.length === 0) {
    return '';
  }
  let out = `User: ${users[0].substring(0, 200)}\n\nAssistant: ${answers[0].substring(0, 200)}`;
  if (users.length > 1) {
    out += '\n\n[... middle of conversation omitted ...]\n';
    out += `\nUser: ${users[users.length - 1].substring(0, 200)}`;
    if (answers.length > 1) {
      out += `\n\nAssistant: ${answers[answers.length - 1].substring(0, 200)}`;
    }
  }
  return out;
}

export function titlePrompt(excerpt: string): string {
  return 'Based on the following conversation, generate a short title (max 6 words) that captures the topic. ' +
    'Also pick a task category from: code, writing, research, analysis, creative, chat, math, translation, health, ' +
    `finance, travel, education, design, productivity, support, other.\n\n${TITLE_LANGUAGE}\n\n` +
    'You MUST respond with valid JSON only. Example:\n{"title": "Debug Login Page Issue", "category": "code"}\n\n' +
    `Conversation:\n${excerpt}`;
}

function cleanTitle(raw: string): string {
  return raw.trim().replace(/^["'“”「」《》]+/, '').replace(/["'“”「」《》]+$/, '').trim().substring(0, 50);
}

/** 模型回的标题:先按 JSON 读,再找 "title": "…",最后接受一行不到 60 字的纯文本。读不出返回空。 */
export function parseTitleReply(raw: string): string {
  const text = raw.trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open >= 0 && close > open) {
    try {
      const obj = JSON.parse(text.substring(open, close + 1)) as Record<string, Object>;
      const title = cleanTitle(`${obj['title'] ?? ''}`);
      if (title.length > 0) {
        return title;
      }
    } catch (_err) {
      // 不是完整 JSON,往下试
    }
  }
  const hit = text.match(/"title"\s*:\s*"([^"]+)"/);
  if (hit) {
    return cleanTitle(hit[1]);
  }
  if (text.length > 0 && text.length < 60 && text.indexOf('\n') < 0 && text.indexOf('{') < 0) {
    return cleanTitle(text);
  }
  return '';
}

// ---- 中断续跑(iOS resume() / 安卓 InterruptedTailDetector) ----

export const CONTINUE_REMINDER: string = '<system-reminder>The user stopped the previous response but now wants ' +
  'to continue. Pick up exactly where you left off.</system-reminder>';
export const STOPPED_NOTE: string = '<system-reminder>The user stopped this response. Content may be ' +
  'incomplete.</system-reminder>';
export const LOST_TOOL_NOTE: string = 'The app stopped before this tool finished, so its result was lost. It may ' +
  'already have run: check its effects before running it again.';

/** 最后一轮没做完:最后一条(摘要不算)是用户的话、说到一半停下的回答,或工具行(工具跑到一半 App 被杀)。 */
export function unfinishedTail(lines: TextLine[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.kind === 'summary') {
      continue;
    }
    if (line.role === 'user') {
      return true;
    }
    if (line.role === 'assistant') {
      return line.kind === 'partial';
    }
    return line.text.startsWith(TOOL_PLAN_PREFIX) || line.text.startsWith(TOOL_RESULT_PREFIX);
  }
  return false;
}

/**
 * 「继续」发给模型的话:iOS 的继续提醒,加上被打断的那一轮已经跑过的工具和结果
 * (鸿蒙的历史里不带工具行,不补上模型就不知道做到哪了),没跑完的工具按 iOS 的说法标出来。
 */
export function resumeNote(lines: TextLine[], upTo: number): string {
  let from = 0;
  for (let i = Math.min(upTo, lines.length) - 1; i >= 0; i--) {
    if (lines[i].role === 'user' && lines[i].kind === '') {
      from = i + 1;
      break;
    }
  }
  const rows: string[] = [];
  let pending: string[] = [];
  for (let i = from; i < Math.min(upTo, lines.length); i++) {
    const text = lines[i].text;
    if (lines[i].role !== 'system') {
      continue;
    }
    if (text.startsWith(TOOL_PLAN_PREFIX)) {
      pending = text.substring(TOOL_PLAN_PREFIX.length).split('、').filter((name: string) => name.length > 0);
      rows.push(`[Tool] ${pending.join(', ')}`);
    } else if (text.startsWith(TOOL_RESULT_PREFIX)) {
      const body = text.substring(TOOL_RESULT_PREFIX.length);
      const colon = body.indexOf(':');
      const name = colon > 0 ? body.substring(0, colon) : body;
      const at = pending.indexOf(name);
      if (at >= 0) {
        pending.splice(at, 1);
      }
      rows.push(`[Result] ${cut(body, 1000)}`);
    }
  }
  for (let i = 0; i < pending.length; i++) {
    rows.push(`[Lost] ${pending[i]}: ${LOST_TOOL_NOTE}`);
  }
  if (rows.length === 0) {
    return CONTINUE_REMINDER;
  }
  return `${CONTINUE_REMINDER}\n\nBefore the interruption these tool calls already ran (results truncated):\n` +
    rows.join('\n');
}

// ---- 技能(iOS SkillStore / 安卓 SkillRepository:提示词里只放索引,正文用 file_read 读) ----

export class SkillMeta {
  id: string = '';
  name: string = '';
  description: string = '';
  version: string = '1.0.0';
}

export const SKILL_INDEX_LIMIT: number = 20;

/** 小写,连续的非字母数字(汉字保留)换成一个 -。 */
export function slugify(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+/, '')
    .replace(/-+$/, '');
  return slug.length > 0 ? slug : 'skill';
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith('\'') && text.endsWith('\'')))) {
    return text.substring(1, text.length - 1);
  }
  return text;
}

/** 从 SKILL.md 的 --- 头里读 name / description / version(支持 | 和 > 多行值)。没写 description 时用正文第一行。 */
export function parseSkillMeta(body: string, fallbackName: string): SkillMeta {
  const meta = new SkillMeta();
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let bodyStart = 0;
  if (lines.length > 0 && lines[0].trim() === '---') {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        end = i;
        break;
      }
    }
    if (end > 0) {
      bodyStart = end + 1;
      let i = 1;
      while (i < end) {
        const hit = lines[i].match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
        i += 1;
        if (!hit) {
          continue;
        }
        const key = hit[1].toLowerCase();
        let value = hit[2].trim();
        if (value === '|' || value === '>' || value === '|-' || value === '>-') {
          const parts: string[] = [];
          while (i < end && (lines[i].startsWith(' ') || lines[i].startsWith('\t') || lines[i].trim() === '')) {
            parts.push(lines[i].trim());
            i += 1;
          }
          value = value.startsWith('|') ? parts.join('\n').trim() : parts.join(' ').trim();
        } else {
          value = unquote(value);
        }
        if (key === 'name') {
          meta.name = value;
        } else if (key === 'description') {
          meta.description = value;
        } else if (key === 'version') {
          meta.version = value.length > 0 ? value : '1.0.0';
        }
      }
    }
  }
  if (meta.name.length === 0) {
    meta.name = fallbackName.trim();
  }
  if (meta.description.length === 0) {
    // 安卓 / iOS 留空;鸿蒙的技能多是在 App 里直接写的,没有 --- 头,留空模型就不知道什么时候该用。
    for (let i = bodyStart; i < lines.length; i++) {
      const line = lines[i].replace(/^#+\s*/, '').trim();
      if (line.length > 0) {
        meta.description = line;
        break;
      }
    }
  }
  meta.id = slugify(meta.name);
  return meta;
}

export function skillPath(id: string): string {
  return `skills/${id}/SKILL.md`;
}

/** file_read 读 skills/<id>/SKILL.md(也认 /var/minis/skills/...)时取出 id,不是技能路径返回空。 */
export function skillIdFromPath(path: string): string {
  const hit = path.trim().match(/^\/?(?:var\/minis\/)?skills\/([^/]+)\/SKILL\.md$/);
  return hit ? hit[1] : '';
}

/** 提示词里的技能索引:和 iOS 同一格式,最多 20 个、说明截到 200 字,按 id 排(提示词前后不变,缓存命中)。 */
export function skillsPromptBlock(rows: SkillMeta[]): string {
  if (rows.length === 0) {
    return '';
  }
  const sorted = rows.slice().sort((a: SkillMeta, b: SkillMeta) => a.id < b.id ? -1 : (a.id > b.id ? 1 : 0));
  const shown = sorted.slice(0, SKILL_INDEX_LIMIT);
  const items: string[] = [];
  for (let i = 0; i < shown.length; i++) {
    const row = shown[i];
    items.push(`  <skill>\n    <name>${row.name}</name>\n    <description>${cut(row.description, 200)}</description>\n` +
      `    <path>${skillPath(row.id)}</path>\n  </skill>`);
  }
  let out = 'Skills:\nReusable instruction sets stored at skills/<name>/SKILL.md. Read the SKILL.md file with ' +
    `file_read to load full instructions before using a skill.\n\n<available_skills>\n${items.join('\n')}\n` +
    '</available_skills>';
  if (sorted.length > shown.length) {
    const rest = sorted.slice(shown.length).map((row: SkillMeta) => row.name);
    out += `\n\n${rest.length} more skills not shown above: ${rest.join(', ')}. Read skills/<id>/SKILL.md to ` +
      'load one.';
  }
  return out;
}

// ---- MCP(iOS NativeMCPClient / leophoneagent-mcp-cli 同一套握手) ----

export const MCP_PROTOCOL_VERSION: string = '2025-06-18';

export function mcpRequest(id: number, method: string, params: string): string {
  return `{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)},"params":${params}}`;
}

export function mcpNotification(method: string): string {
  return `{"jsonrpc":"2.0","method":${JSON.stringify(method)}}`;
}

export function mcpInitializeParams(appVersion: string): string {
  return `{"protocolVersion":${JSON.stringify(MCP_PROTOCOL_VERSION)},"capabilities":{},` +
    `"clientInfo":{"name":"LeoPhoneAgent","version":${JSON.stringify(appVersion)}}}`;
}

/**
 * 从回复里取出 JSON-RPC 那一条:普通 JSON 直接用;text/event-stream 找 id 对得上、带 result 或 error 的 data 行,
 * 找不到就用最后一条能解析的。都不行返回空。
 */
export function mcpReply(raw: string, id: number): string {
  const text = raw.trim();
  if (text.startsWith('{')) {
    return text;
  }
  let last = '';
  const rows = text.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i].trim();
    if (!row.startsWith('data:')) {
      continue;
    }
    const data = row.substring(5).trim();
    try {
      const obj = JSON.parse(data) as Record<string, Object>;
      last = data;
      if (Number(obj['id'] ?? -1) === id && (obj['result'] !== undefined || obj['error'] !== undefined)) {
        return data;
      }
    } catch (_err) {
      // 不是 JSON 的 data 行
    }
  }
  return last;
}

/** JSON-RPC 的 error.message;没有错误返回空。 */
export function mcpError(reply: string): string {
  try {
    const obj = JSON.parse(reply) as Record<string, Object>;
    const err = obj['error'] as Record<string, Object> | undefined;
    if (err) {
      const message = `${err['message'] ?? ''}`.trim();
      return message.length > 0 ? message : `MCP 错误 ${err['code'] ?? ''}`.trim();
    }
  } catch (_err) {
    return '回复不是 JSON';
  }
  return '';
}

export function mcpToolNames(reply: string): string[] {
  try {
    const obj = JSON.parse(reply) as Record<string, Object>;
    const result = obj['result'] as Record<string, Object> | undefined;
    const tools = result ? result['tools'] : undefined;
    if (!Array.isArray(tools)) {
      return [];
    }
    const names: string[] = [];
    for (let i = 0; i < tools.length; i++) {
      const name = `${(tools[i] as Record<string, Object>)['name'] ?? ''}`;
      if (name.length > 0) {
        names.push(name);
      }
    }
    return names;
  } catch (_err) {
    return [];
  }
}

/** 提示词里的 MCP 服务器清单(iOS 的写法,只是 CLI 换成了 mcp_tools / mcp_call 两个工具)。最多 20 个。 */
export function mcpPromptBlock(labels: string[], tools: string[]): string {
  if (labels.length === 0) {
    return '';
  }
  const rows: string[] = [];
  for (let i = 0; i < labels.length && i < 20; i++) {
    const note = i < tools.length && tools[i].length > 0 ? tools[i] : 'tools not listed yet';
    rows.push(`- ${labels[i]}: ${cut(note, 200)}`);
  }
  return 'Available MCP Servers (use the mcp_tools and mcp_call tools to discover and call):\n' +
    `${rows.join('\n')}\n\nTo use: call mcp_tools with the server to see its tools and input schemas, then ` +
    'mcp_call with server, name and arguments (a JSON object).\n' +
    'Values written as $$VARNAME in MCP settings are filled in from this phone\'s environment variables.';
}

// ---- 网页搜索(鸿蒙没有命令行,给一个不用钥匙的搜索;iOS 用智谱 MCP 预设,鸿蒙也有) ----

export class SearchHit {
  title: string = '';
  url: string = '';
  snippet: string = '';
}

function decodeEntities(text: string): string {
  return text.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'').replace(/&#x27;/g, '\'').replace(/&#183;/g, '·').replace(/&ensp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const B64: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url → 文本(UTF-8)。Bing 的跳转链接把真实地址这样编码在 u=a1… 里。 */
function base64UrlText(raw: string): string {
  const clean = raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  let escaped = '';
  for (let i = 0; i < clean.length; i++) {
    const index = B64.indexOf(clean.charAt(i));
    if (index < 0) {
      return '';
    }
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const byte = (value >> bits) & 0xff;
      escaped += `%${byte < 16 ? '0' : ''}${byte.toString(16)}`;
    }
  }
  try {
    return decodeURIComponent(escaped);
  } catch (_err) {
    return '';
  }
}

function realBingUrl(href: string): string {
  const url = decodeEntities(href);
  if (url.indexOf('bing.com/ck/a') < 0) {
    return url;
  }
  const hit = url.match(/[?&]u=a1([^&]+)/);
  const decoded = hit ? base64UrlText(hit[1]) : '';
  return decoded.startsWith('http') ? decoded : url;
}

export function parseBingResults(html: string, limit: number): SearchHit[] {
  const out: SearchHit[] = [];
  const blocks = html.split(/<li class="b_algo/);
  for (let i = 1; i < blocks.length && out.length < limit; i++) {
    const block = blocks[i];
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) {
      continue;
    }
    const hit = new SearchHit();
    hit.url = realBingUrl(link[1]);
    hit.title = stripTags(link[2]);
    const para = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    hit.snippet = para ? stripTags(para[1]) : '';
    if (hit.url.startsWith('http') && hit.title.length > 0) {
      out.push(hit);
    }
  }
  return out;
}

export function parseDdgResults(html: string, limit: number): SearchHit[] {
  const out: SearchHit[] = [];
  const blocks = html.split(/class="result__a"/);
  for (let i = 1; i < blocks.length && out.length < limit; i++) {
    const block = blocks[i];
    const link = block.match(/href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) {
      continue;
    }
    let url = decodeEntities(link[1]);
    const target = url.match(/[?&]uddg=([^&]+)/);
    if (target) {
      try {
        url = decodeURIComponent(target[1]);
      } catch (_err) {
        // 保留原链接
      }
    }
    if (url.startsWith('//')) {
      url = `https:${url}`;
    }
    const hit = new SearchHit();
    hit.url = url;
    hit.title = stripTags(link[2]);
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    hit.snippet = snippet ? stripTags(snippet[1]) : '';
    if (hit.url.startsWith('http') && hit.title.length > 0) {
      out.push(hit);
    }
  }
  return out;
}

export function formatSearchHits(query: string, hits: SearchHit[]): string {
  if (hits.length === 0) {
    return `没搜到「${query}」的结果(搜索页可能要验证码)。可以换个说法再搜,或用 web_fetch 打开 ` +
      `https://cn.bing.com/search?q=${encodeURIComponent(query)} 看看。`;
  }
  const rows: string[] = [`搜索「${query}」的前 ${hits.length} 条结果:`];
  for (let i = 0; i < hits.length; i++) {
    rows.push(`${i + 1}. ${hits[i].title}\n   ${hits[i].url}${hits[i].snippet.length > 0 ?
      `\n   ${cut(hits[i].snippet, 300)}` : ''}`);
  }
  rows.push('要看全文,用 web_fetch 打开链接。');
  return rows.join('\n');
}

// ---- 定时任务 ----

export function dayKeyOf(stamp: number): string {
  const date = new Date(stamp);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * 今天到点了、今天还没跑过就该跑。App 关着、在后台时错过的,回来(或系统在后台唤起)时补跑今天这一次;
 * 更早的不补,也不叠着跑。
 */
export function scheduleDue(hour: number, minute: number, on: boolean, lastDay: string, now: number): boolean {
  if (!on || lastDay === dayKeyOf(now)) {
    return false;
  }
  const fire = new Date(now);
  fire.setHours(hour, minute, 0, 0);
  return fire.getTime() <= now;
}

// ---- 完成通知(iOS BackgroundKeepAliveManager 的写法) ----

/** Markdown → 一行纯文字,截到 max 字。 */
export function plainPreview(markdown: string, max: number): string {
  const text = markdown.replace(/```[\s\S]*?```/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_`>|~]/g, '').replace(/\s+/g, ' ').trim();
  return cut(text, max);
}

/** [标题, 正文]。outcome:done / failed / interrupted / approval(等你确认写文件)。 */
export function doneNotice(outcome: string, title: string, reply: string): string[] {
  const name = title.trim().length > 0 ? title.trim() : '本机任务';
  if (outcome === 'interrupted') {
    return [`⏸ ${name}`, '任务中断,回到 app 可继续。'];
  }
  if (outcome === 'approval') {
    return [`✋ ${name}`, '要写文件,等你确认。'];
  }
  const preview = plainPreview(reply, 200);
  if (outcome === 'failed') {
    return [`❌ ${name}`, preview.length > 0 ? preview : '任务执行失败。'];
  }
  return [`✅ ${name}`, preview.length > 0 ? preview : '任务已完成。'];
}
