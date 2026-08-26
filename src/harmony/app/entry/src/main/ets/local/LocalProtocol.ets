import { util } from '@kit.ArkTS';

export class PackedTurn {
  role: string = 'user';
  content: string = '';
}

export class LocalChatMessage {
  role: string = 'user';
  text: string = '';
  imageB64: string = '';
  imageMime: string = '';
  imagePath: string = '';

  static pack(messages: LocalChatMessage[], systemPrompt: string): PackedTurn[] {
    const out: PackedTurn[] = [];
    if (systemPrompt.trim().length > 0) {
      const sys = new PackedTurn();
      sys.role = 'system';
      sys.content = systemPrompt;
      out.push(sys);
    }
    for (let i = 0; i < messages.length; i++) {
      const turn = new PackedTurn();
      turn.role = messages[i].role;
      turn.content = messages[i].text;
      out.push(turn);
    }
    return out;
  }
}

export class LocalSessionArchive {
  title: string = '';
  messages: LocalChatMessage[] = [];
}

export function normalizeProviderRoot(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function isPrivateHttpHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1') {
    return true;
  }
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return true;
  }
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) {
    return true;
  }
  return false;
}

export function requireProviderRoot(raw: string): string {
  const root = normalizeProviderRoot(raw);
  const lower = root.toLowerCase();
  if (lower.startsWith('https://')) {
    const rest = root.substring('https://'.length);
    if (!rest || rest.indexOf('@') >= 0 || rest.indexOf(' ') >= 0 || rest.indexOf('#') >= 0) {
      throw new Error('供应商根不合法');
    }
    return root;
  }
  if (lower.startsWith('http://')) {
    const hostPort = root.substring('http://'.length).split('/')[0];
    let host = hostPort;
    if (hostPort.startsWith('[')) {
      const end = hostPort.indexOf(']');
      host = end > 0 ? hostPort.substring(0, end + 1) : '';
    } else {
      host = hostPort.split(':')[0];
    }
    if (isPrivateHttpHost(host)) {
      return root;
    }
    throw new Error('供应商根只有 https，或本机/局域网 http');
  }
  throw new Error('供应商根必须是 https://');
}

export function chatCompletionsUrl(root: string): string {
  return normalizeProviderRoot(root) + '/chat/completions';
}

export function providerWire(type: string, root: string): string {
  const host = root.toLowerCase();
  if (type === 'anthropic' && host.indexOf('api.anthropic.com') >= 0) {
    return 'anthropic';
  }
  if (type === 'gemini' && host.indexOf('generativelanguage.googleapis.com') >= 0 &&
    host.indexOf('/openai') < 0) {
    return 'gemini';
  }
  return 'openai';
}

export function anthropicMessagesUrl(root: string): string {
  const base = normalizeProviderRoot(root);
  if (base.endsWith('/messages')) {
    return base;
  }
  return `${base}/messages`;
}

export function geminiStreamUrl(root: string, model: string): string {
  return `${normalizeProviderRoot(root)}/models/${model}:streamGenerateContent?alt=sse`;
}

export function anthropicDeltaFromJson(json: object): string {
  const obj = json as Record<string, Object>;
  if (`${obj['type'] ?? ''}` !== 'content_block_delta') {
    return '';
  }
  const delta = obj['delta'] as Record<string, Object> | undefined;
  if (!delta) {
    return '';
  }
  return `${delta['text'] ?? ''}`;
}

export function geminiDeltaFromJson(json: object): string {
  const obj = json as Record<string, Object>;
  const rows = obj['candidates'];
  if (!Array.isArray(rows) || rows.length === 0) {
    return '';
  }
  const cand = rows[0] as Record<string, Object>;
  const content = cand['content'] as Record<string, Object> | undefined;
  const parts = content ? content['parts'] : undefined;
  if (!Array.isArray(parts)) {
    return '';
  }
  let text = '';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as Record<string, Object>;
    text += `${part['text'] ?? ''}`;
  }
  return text;
}

export function openAiDeltaFromJson(json: object): string {
  const obj = json as Record<string, Object>;
  const rows = obj['choices'];
  if (!Array.isArray(rows) || rows.length === 0) {
    return '';
  }
  const choice = rows[0] as Record<string, Object>;
  const delta = choice['delta'] as Record<string, Object> | undefined;
  if (delta && delta['content'] !== undefined) {
    return `${delta['content'] ?? ''}`;
  }
  const message = choice['message'] as Record<string, Object> | undefined;
  if (message && message['content'] !== undefined) {
    return `${message['content'] ?? ''}`;
  }
  return '';
}

export function openAiErrorFromJson(json: object): string {
  const obj = json as Record<string, Object>;
  const err = obj['error'] as Record<string, Object> | undefined;
  if (err && err['message'] !== undefined) {
    const text = `${err['message'] ?? ''}`;
    if (text.length > 0) {
      return text;
    }
  }
  if (obj['message'] !== undefined) {
    return `${obj['message'] ?? ''}`;
  }
  return '';
}

export function sessionArchiveFromJson(json: object): LocalSessionArchive | null {
  const obj = json as Record<string, Object>;
  const rows = obj['messages'];
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  const messages: LocalChatMessage[] = [];
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i] as Record<string, Object>;
    const role = `${item['role'] ?? ''}`;
    let text = `${item['text'] ?? ''}`;
    if (!text) {
      text = `${item['content'] ?? ''}`;
    }
    text = text.trim();
    const imageB64 = `${item['imageB64'] ?? ''}`;
    const imagePath = `${item['imagePath'] ?? ''}`;
    if (!role || (text.length === 0 && imageB64.length === 0 && imagePath.length === 0)) {
      continue;
    }
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      continue;
    }
    const line = new LocalChatMessage();
    line.role = role;
    line.text = text.length > 0 ? text : '看这张图';
    line.imageB64 = imageB64;
    line.imageMime = `${item['imageMime'] ?? ''}`;
    line.imagePath = imagePath;
    messages.push(line);
  }
  if (messages.length === 0) {
    return null;
  }
  const archive = new LocalSessionArchive();
  const title = `${obj['title'] ?? ''}`.trim();
  archive.title = title.length > 0 ? title : titleFromPrompt(messages[0].text);
  archive.messages = messages;
  return archive;
}

export function extractLinks(text: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[^\s<>)\]"']+/g;
  let match: RegExpExecArray | null = re.exec(text);
  while (match) {
    const raw = match[0].replace(/[.,;:!?]+$/, '');
    if (allowOpenUrl(raw).length === 0) {
      out.push(raw);
    }
    match = re.exec(text);
  }
  return out;
}

export function allowOpenUrl(raw: string): string {
  const url = raw.trim();
  if (!url) {
    return '空链接';
  }
  const lower = url.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('file:') || lower.startsWith('data:')) {
    return '这种链接不能打开';
  }
  if (lower.startsWith('https://')) {
    if (url.indexOf(' ') >= 0 || url.indexOf('@') >= 0) {
      return '链接不合法';
    }
    return '';
  }
  if (lower.startsWith('http://')) {
    const hostPort = url.substring('http://'.length).split('/')[0];
    const host = hostPort.startsWith('[') ? hostPort.split(']')[0] + ']' : hostPort.split(':')[0];
    if (isPrivateHttpHost(host)) {
      return '';
    }
    return '外网链接只用 https';
  }
  return '只打开 http/https 链接';
}

export function titleFromPrompt(text: string): string {
  const line = text.trim().replace(/\s+/g, ' ');
  if (!line) {
    return '新任务';
  }
  return line.length > 32 ? line.substring(0, 32) + '…' : line;
}

export function parseSseData(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return '';
  }
  return trimmed.substring(5).trim();
}

export function dateBucket(updatedAt: number, now: number = Date.now()): string {
  if (!updatedAt) {
    return 'earlier';
  }
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (updatedAt >= today) {
    return 'today';
  }
  if (updatedAt >= today - 86400000) {
    return 'yesterday';
  }
  const diffDays = Math.floor((now - updatedAt) / 86400000);
  if (diffDays < 7) {
    return 'week';
  }
  const monthAgo = new Date(now);
  monthAgo.setMonth(monthAgo.getMonth() - 1);
  if (updatedAt > monthAgo.getTime()) {
    return 'month';
  }
  return 'earlier';
}

export function relativeTime(stamp: number, now: number = Date.now()): string {
  if (!stamp) {
    return '';
  }
  const diff = now - stamp;
  if (diff < 60000) {
    return '刚刚';
  }
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (stamp >= start.getTime() - 86400000) {
    return '昨天';
  }
  if (diff < 7 * 86400000) {
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return days[new Date(stamp).getDay()];
  }
  const date = new Date(stamp);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function bucketTitle(bucket: string): string {
  if (bucket === 'pinned') {
    return '置顶';
  }
  if (bucket === 'today') {
    return '今天';
  }
  if (bucket === 'yesterday') {
    return '昨天';
  }
  if (bucket === 'week') {
    return '本周';
  }
  if (bucket === 'month') {
    return '本月';
  }
  return '更早';
}

export function nextThinking(current: string): string {
  if (current === '') {
    return 'low';
  }
  if (current === 'low') {
    return 'medium';
  }
  if (current === 'medium') {
    return 'high';
  }
  return '';
}

export class ToolCall {
  id: string = '';
  name: string = '';
  args: string = '';
}

export class LoopTurn {
  role: string = 'user';
  content: string = '';
  toolCallId: string = '';
  toolName: string = '';
  calls: ToolCall[] = [];
  imageB64: string = '';
  imageMime: string = 'image/jpeg';
}

export const WRITE_GRANT_MARK: string = '__NEED_WRITE_GRANT__';

export function htmlToText(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sandboxFileName(path: string): string {
  let raw = path.trim().replace(/^\/+/, '');
  if (raw.startsWith('workspace/')) {
    raw = raw.substring('workspace/'.length);
  }
  if (raw.startsWith('var/minis/workspace/')) {
    raw = raw.substring('var/minis/workspace/'.length);
  }
  if (!raw) {
    throw new Error('文件名不能空');
  }
  if (raw.indexOf('..') >= 0 || raw.indexOf('/') >= 0 || raw.indexOf('\\') >= 0) {
    throw new Error('只允许沙箱根目录下的文件名');
  }
  return raw;
}

export function finishReasonFromJson(json: object): string {
  const obj = json as Record<string, Object>;
  const rows = obj['choices'];
  if (!Array.isArray(rows) || rows.length === 0) {
    return '';
  }
  const choice = rows[0] as Record<string, Object>;
  return `${choice['finish_reason'] ?? ''}`;
}

export function applyToolDelta(acc: ToolCall[], json: object): ToolCall[] {
  const obj = json as Record<string, Object>;
  const rows = obj['choices'];
  if (!Array.isArray(rows) || rows.length === 0) {
    return acc;
  }
  const choice = rows[0] as Record<string, Object>;
  const delta = (choice['delta'] ?? choice['message']) as Record<string, Object> | undefined;
  if (!delta) {
    return acc;
  }
  const calls = delta['tool_calls'];
  if (!Array.isArray(calls)) {
    return acc;
  }
  const next: ToolCall[] = [];
  for (let i = 0; i < acc.length; i++) {
    const copy = new ToolCall();
    copy.id = acc[i].id;
    copy.name = acc[i].name;
    copy.args = acc[i].args;
    next.push(copy);
  }
  for (let i = 0; i < calls.length; i++) {
    const item = calls[i] as Record<string, Object>;
    const index = Number(item['index'] ?? next.length);
    while (next.length <= index) {
      next.push(new ToolCall());
    }
    const cur = next[index];
    const id = `${item['id'] ?? ''}`;
    if (id.length > 0) {
      cur.id = id;
    }
    const fn = item['function'] as Record<string, Object> | undefined;
    if (fn) {
      const name = `${fn['name'] ?? ''}`;
      if (name.length > 0 && cur.name.length === 0) {
        cur.name = name;
      }
      cur.args += `${fn['arguments'] ?? ''}`;
    }
  }
  return next;
}

export function toolArg(raw: string, key: string): string {
  try {
    const obj = JSON.parse(raw) as Record<string, Object>;
    if (obj[key] === undefined || obj[key] === null) {
      return '';
    }
    return `${obj[key]}`;
  } catch (_err) {
    return '';
  }
}

export function wireMessagesJson(turns: LoopTurn[], systemPrompt: string): string {
  const rows: string[] = [];
  if (systemPrompt.trim().length > 0) {
    const sys = new PackedTurn();
    sys.role = 'system';
    sys.content = systemPrompt;
    rows.push(JSON.stringify(sys));
  }
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role === 'tool') {
      rows.push(`{"role":"tool","tool_call_id":${JSON.stringify(turn.toolCallId)},"content":${JSON.stringify(turn.content)}}`);
    } else if (turn.calls.length > 0) {
      const calls: string[] = [];
      for (let j = 0; j < turn.calls.length; j++) {
        const call = turn.calls[j];
        calls.push(`{"id":${JSON.stringify(call.id)},"type":"function","function":{"name":${JSON.stringify(call.name)},"arguments":${JSON.stringify(call.args)}}}`);
      }
      rows.push(`{"role":"assistant","content":${JSON.stringify(turn.content)},"tool_calls":[${calls.join(',')}]}`);
    } else if (turn.imageB64.length > 0) {
      rows.push(`{"role":${JSON.stringify(turn.role)},"content":[{"type":"text","text":${JSON.stringify(turn.content)}},{"type":"image_url","image_url":{"url":"data:${turn.imageMime};base64,${turn.imageB64}"}}]}`);
    } else {
      const packed = new PackedTurn();
      packed.role = turn.role;
      packed.content = turn.content;
      rows.push(JSON.stringify(packed));
    }
  }
  return `[${rows.join(',')}]`;
}

export function localToolSchemaJson(): string {
  return '[' +
    '{"type":"function","function":{"name":"file_list","description":"List files in the Harmony app sandbox workspace.","parameters":{"type":"object","properties":{"tool_title":{"type":"string"}},"required":["tool_title"]}}},' +
    '{"type":"function","function":{"name":"file_read","description":"Read a text file from the Harmony app sandbox. Head pages that still have unread lines append next_offset.","parameters":{"type":"object","properties":{"tool_title":{"type":"string"},"path":{"type":"string"},"offset":{"type":"integer"},"lines":{"type":"integer"},"max_length":{"type":"integer"},"direction":{"type":"string"}},"required":["tool_title","path"]}}},' +
    '{"type":"function","function":{"name":"file_write","description":"Write a text file in the Harmony app sandbox. User must approve writes.","parameters":{"type":"object","properties":{"tool_title":{"type":"string"},"path":{"type":"string"},"content":{"type":"string"}},"required":["tool_title","path","content"]}}},' +
    '{"type":"function","function":{"name":"file_edit","description":"Replace the first occurrence of old text in a sandbox file.","parameters":{"type":"object","properties":{"tool_title":{"type":"string"},"path":{"type":"string"},"old":{"type":"string"},"new":{"type":"string"}},"required":["tool_title","path","old","new"]}}},' +
    '{"type":"function","function":{"name":"memory_write","description":"Append a memory entry to today daily log.","parameters":{"type":"object","properties":{"tool_title":{"type":"string"},"content":{"type":"string"}},"required":["tool_title","content"]}}},' +
    '{"type":"function","function":{"name":"memory_get","description":"Search persistent memories.","parameters":{"type":"object","properties":{"tool_title":{"type":"string"},"scope":{"type":"string"},"keywords":{"type":"string"}},"required":["tool_title"]}}},' +
    '{"type":"function","function":{"name":"open_url","description":"Open an http(s) link in the in-app browser.","parameters":{"type":"object","properties":{"tool_title":{"type":"string"},"url":{"type":"string"}},"required":["tool_title","url"]}}},' +
    '{"type":"function","function":{"name":"web_fetch","description":"Download a public https page as text.","parameters":{"type":"object","properties":{"tool_title":{"type":"string"},"url":{"type":"string"}},"required":["tool_title","url"]}}},' +
    '{"type":"function","function":{"name":"browser_use","description":"Open or manage up to 3 in-app browser tabs.","parameters":{"type":"object","properties":{"tool_title":{"type":"string"},"action":{"type":"string"},"url":{"type":"string"},"tab_id":{"type":"string"}},"required":["tool_title","action"]}}},' +
    '{"type":"function","function":{"name":"mcp_call","description":"Call a configured HTTP MCP tool.","parameters":{"type":"object","properties":{"tool_title":{"type":"string"},"server":{"type":"string"},"name":{"type":"string"},"arguments":{"type":"string"}},"required":["tool_title","server","name"]}}}' +
    ']';
}

export function anthropicToolSchemaJson(): string {
  const rows = JSON.parse(localToolSchemaJson()) as Object[];
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i] as Record<string, Object>;
    const fn = item['function'] as Record<string, Object>;
    out.push(`{"name":${JSON.stringify(fn['name'])},"description":${JSON.stringify(fn['description'])},"input_schema":${JSON.stringify(fn['parameters'])}}`);
  }
  return `[${out.join(',')}]`;
}

export function geminiToolSchemaJson(): string {
  const rows = JSON.parse(localToolSchemaJson()) as Object[];
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i] as Record<string, Object>;
    const fn = item['function'] as Record<string, Object>;
    out.push(`{"name":${JSON.stringify(fn['name'])},"description":${JSON.stringify(fn['description'])},"parameters":${JSON.stringify(fn['parameters'])}}`);
  }
  return `[{"function_declarations":[${out.join(',')}]}]`;
}

export function applyAnthropicToolDelta(acc: ToolCall[], json: object): ToolCall[] {
  const obj = json as Record<string, Object>;
  const type = `${obj['type'] ?? ''}`;
  const next: ToolCall[] = [];
  for (let i = 0; i < acc.length; i++) {
    const copy = new ToolCall();
    copy.id = acc[i].id;
    copy.name = acc[i].name;
    copy.args = acc[i].args;
    next.push(copy);
  }
  if (type === 'content_block_start') {
    const block = obj['content_block'] as Record<string, Object> | undefined;
    if (block && `${block['type'] ?? ''}` === 'tool_use') {
      const call = new ToolCall();
      call.id = `${block['id'] ?? ''}`;
      call.name = `${block['name'] ?? ''}`;
      const input = block['input'];
      call.args = input === undefined || input === null ? '' : JSON.stringify(input);
      if (call.args === '{}') {
        call.args = '';
      }
      next.push(call);
    }
    return next;
  }
  if (type === 'content_block_delta' && next.length > 0) {
    const delta = obj['delta'] as Record<string, Object> | undefined;
    if (delta) {
      next[next.length - 1].args += `${delta['partial_json'] ?? ''}`;
    }
  }
  return next;
}

export function applyGeminiToolDelta(acc: ToolCall[], json: object): ToolCall[] {
  const obj = json as Record<string, Object>;
  const rows = obj['candidates'];
  if (!Array.isArray(rows) || rows.length === 0) {
    return acc;
  }
  const cand = rows[0] as Record<string, Object>;
  const content = cand['content'] as Record<string, Object> | undefined;
  const parts = content ? content['parts'] : undefined;
  if (!Array.isArray(parts)) {
    return acc;
  }
  const next: ToolCall[] = [];
  for (let i = 0; i < acc.length; i++) {
    const copy = new ToolCall();
    copy.id = acc[i].id;
    copy.name = acc[i].name;
    copy.args = acc[i].args;
    next.push(copy);
  }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as Record<string, Object>;
    const call = part['functionCall'] as Record<string, Object> | undefined;
    if (!call) {
      continue;
    }
    const row = new ToolCall();
    row.name = `${call['name'] ?? ''}`;
    row.id = `gemini_${next.length}`;
    const args = call['args'];
    row.args = args === undefined || args === null ? '{}' : JSON.stringify(args);
    next.push(row);
  }
  return next;
}

export function anthropicMessagesJson(turns: LoopTurn[]): string {
  const rows: string[] = [];
  let tools: string[] = [];
  const flushTools = (): void => {
    if (tools.length === 0) {
      return;
    }
    rows.push(`{"role":"user","content":[${tools.join(',')}]}`);
    tools = [];
  };
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role === 'tool') {
      tools.push(`{"type":"tool_result","tool_use_id":${JSON.stringify(turn.toolCallId)},"content":${JSON.stringify(turn.content)}}`);
      continue;
    }
    flushTools();
    if (turn.calls.length > 0) {
      const blocks: string[] = [];
      if (turn.content.length > 0) {
        blocks.push(`{"type":"text","text":${JSON.stringify(turn.content)}}`);
      }
      for (let j = 0; j < turn.calls.length; j++) {
        const call = turn.calls[j];
        let input = '{}';
        try {
          JSON.parse(call.args.length > 0 ? call.args : '{}');
          input = call.args.length > 0 ? call.args : '{}';
        } catch (_err) {
          input = '{}';
        }
        blocks.push(`{"type":"tool_use","id":${JSON.stringify(call.id)},"name":${JSON.stringify(call.name)},"input":${input}}`);
      }
      rows.push(`{"role":"assistant","content":[${blocks.join(',')}]}`);
    } else if (turn.imageB64.length > 0) {
      const media = turn.imageMime.length > 0 ? turn.imageMime : 'image/jpeg';
      rows.push(`{"role":"user","content":[{"type":"text","text":${JSON.stringify(turn.content)}},{"type":"image","source":{"type":"base64","media_type":${JSON.stringify(media)},"data":${JSON.stringify(turn.imageB64)}}}]}`);
    } else {
      rows.push(`{"role":${JSON.stringify(turn.role === 'assistant' ? 'assistant' : 'user')},"content":${JSON.stringify(turn.content)}}`);
    }
  }
  flushTools();
  return `[${rows.join(',')}]`;
}

export function geminiContentsJson(turns: LoopTurn[]): string {
  const rows: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role === 'tool') {
      const replyName = turn.toolName.length > 0 ? turn.toolName : turn.toolCallId;
      // 这里原来多写了一个 }：functionResponse 段收尾是 content} + response} + functionResponse} + parts 元素}，
      // 共四层，之前写了五个 }，整个 contents 数组变成非法 JSON。Gemini 只要走一次工具调用，
      // 第二轮请求体就必然 400，而 shouldFailover('http 4') 又会把所有供应商轮一遍，
      // 最后只报「供应商都试过了」，真因被完全掩盖。
      rows.push(`{"role":"user","parts":[{"functionResponse":{"name":${JSON.stringify(replyName)},"response":{"content":${JSON.stringify(turn.content)}}}}]}`);
    } else if (turn.calls.length > 0) {
      const parts: string[] = [];
      if (turn.content.length > 0) {
        parts.push(`{"text":${JSON.stringify(turn.content)}}`);
      }
      for (let j = 0; j < turn.calls.length; j++) {
        const call = turn.calls[j];
        let args = '{}';
        try {
          JSON.parse(call.args.length > 0 ? call.args : '{}');
          args = call.args.length > 0 ? call.args : '{}';
        } catch (_err) {
          args = '{}';
        }
        parts.push(`{"functionCall":{"name":${JSON.stringify(call.name)},"args":${args}}}`);
      }
      rows.push(`{"role":"model","parts":[${parts.join(',')}]}`);
    } else if (turn.imageB64.length > 0) {
      const media = turn.imageMime.length > 0 ? turn.imageMime : 'image/jpeg';
      rows.push(`{"role":"user","parts":[{"text":${JSON.stringify(turn.content)}},{"inlineData":{"mimeType":${JSON.stringify(media)},"data":${JSON.stringify(turn.imageB64)}}}]}`);
    } else {
      const role = turn.role === 'assistant' ? 'model' : 'user';
      rows.push(`{"role":${JSON.stringify(role)},"parts":[{"text":${JSON.stringify(turn.content)}}]}`);
    }
  }
  return `[${rows.join(',')}]`;
}

export class MdBlock {
  kind: string = 'p';
  text: string = '';
}

export class MdTableRow {
  cells: string[] = [];
}

export function parseTableRows(raw: string): MdTableRow[] {
  const lines = raw.split('\n');
  const out: MdTableRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split('|');
    const row = new MdTableRow();
    for (let j = 0; j < parts.length; j++) {
      if (j === 0 && parts[j].trim() === '') {
        continue;
      }
      if (j === parts.length - 1 && parts[j].trim() === '') {
        continue;
      }
      row.cells.push(parts[j].trim());
    }
    if (row.cells.length > 0) {
      out.push(row);
    }
  }
  return out;
}

export function splitMarkdown(raw: string): MdBlock[] {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        i += 1;
      }
      const block = new MdBlock();
      block.kind = 'code';
      block.text = buf.join('\n');
      out.push(block);
      continue;
    }
    if (line.startsWith('|') && line.indexOf('|', 1) > 0) {
      const rows: string[] = [line];
      i += 1;
      while (i < lines.length && lines[i].startsWith('|')) {
        if (lines[i].indexOf('---') < 0) {
          rows.push(lines[i]);
        }
        i += 1;
      }
      const block = new MdBlock();
      block.kind = 'table';
      block.text = rows.join('\n');
      out.push(block);
      continue;
    }
    const block = new MdBlock();
    if (line.startsWith('### ')) {
      block.kind = 'h3';
      block.text = line.substring(4);
    } else if (line.startsWith('## ')) {
      block.kind = 'h2';
      block.text = line.substring(3);
    } else if (line.startsWith('# ')) {
      block.kind = 'h1';
      block.text = line.substring(2);
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      block.kind = 'li';
      block.text = line.substring(2);
    } else if (/^\d+\.\s/.test(line)) {
      block.kind = 'li';
      block.text = line.replace(/^\d+\.\s/, '');
    } else {
      block.kind = 'p';
      block.text = line.replace(/\*\*(.*?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
    }
    out.push(block);
    i += 1;
  }
  if (out.length === 0) {
    const empty = new MdBlock();
    empty.text = raw;
    return [empty];
  }
  return out;
}

export class FailoverSlot {
  instanceId: string = '';
  model: string = '';
}

export class ProviderSlot {
  id: string = '';
  label: string = '';
  model: string = '';
  enabled: boolean = true;
  type: string = '';
}

export function resolveFailoverQueue(activeId: string, instances: ProviderSlot[],
  groupIds: string[]): FailoverSlot[] {
  const out: FailoverSlot[] = [];
  const seen: string[] = [];
  const push = (instanceId: string, model: string): void => {
    const key = `${instanceId}/${model}`;
    if (seen.indexOf(key) >= 0 || !instanceId || !model) {
      return;
    }
    seen.push(key);
    const slot = new FailoverSlot();
    slot.instanceId = instanceId;
    slot.model = model;
    out.push(slot);
  };
  for (let i = 0; i < groupIds.length; i++) {
    const raw = groupIds[i];
    if (raw.indexOf('/') < 0) {
      continue;
    }
    // 组条目是 ModelGroupsPage 里拼的 `${label}/${model}`。原来用 lastIndexOf('/') 反着切，
    // 遇到 OpenRouter 这种模型 id 自带斜杠的（anthropic/claude-3-opus）就会切成
    // label='OpenRouter/anthropic'、model='claude-3-opus'，匹配不到任何实例，
    // 该条目被静默丢掉，模型组等于没生效。改成按已知的实例标签做前缀匹配，
    // 标签和模型 id 两边带斜杠都不会切错。
    for (let j = 0; j < instances.length; j++) {
      const tag = instances[j].label.length > 0 ? instances[j].label : instances[j].type;
      if (!instances[j].enabled || tag.length === 0) {
        continue;
      }
      if (raw.startsWith(`${tag}/`)) {
        push(instances[j].id, raw.substring(tag.length + 1));
        break;
      }
    }
  }
  if (out.length === 0) {
    let active: ProviderSlot | null = null;
    for (let i = 0; i < instances.length; i++) {
      if (instances[i].id === activeId && instances[i].enabled) {
        active = instances[i];
      }
    }
    if (!active) {
      for (let i = 0; i < instances.length; i++) {
        if (instances[i].enabled) {
          active = instances[i];
          break;
        }
      }
    }
    if (active) {
      push(active.id, active.model);
    }
  }
  return out;
}

export function shouldFailover(message: string): boolean {
  const text = message.toLowerCase();
  // 原来这里是 indexOf('rate')，任何含 generate / moderate / separate 的错误文案都会误判成限流；
  // 原来的 'http 4' 还覆盖了 400/404 —— 这两类是我们自己请求写错了，换一家一样错，
  // 只会把所有供应商刷一遍再报「供应商都试过了」，把真正的报错吞掉。
  // 现在只对确实换一家可能好转的情况做 failover。
  if (text.indexOf('http 400') >= 0 || text.indexOf('http 404') >= 0 ||
    text.indexOf('http 422') >= 0) {
    return false;
  }
  return text.indexOf('unauthorized') >= 0 ||
    text.indexOf('http 4') >= 0 ||
    text.indexOf('http 5') >= 0 ||
    text.indexOf('overloaded') >= 0 ||
    text.indexOf('rate limit') >= 0 ||
    text.indexOf('rate_limit') >= 0 ||
    text.indexOf('429') >= 0 ||
    text.indexOf('timeout') >= 0;
}

export function usageFromJson(json: object): number[] {
  const obj = json as Record<string, Object>;
  const usage = obj['usage'] as Record<string, Object> | undefined;
  if (usage) {
    const prompt = Number(usage['prompt_tokens'] ?? usage['input_tokens'] ?? 0);
    const completion = Number(usage['completion_tokens'] ?? usage['output_tokens'] ?? 0);
    if (prompt > 0 || completion > 0) {
      return [prompt, completion];
    }
  }
  const meta = obj['usageMetadata'] as Record<string, Object> | undefined;
  if (meta) {
    return [Number(meta['promptTokenCount'] ?? 0), Number(meta['candidatesTokenCount'] ?? 0)];
  }
  return [0, 0];
}

export class DeviceAuth {
  deviceCode: string = '';
  userCode: string = '';
  verificationUri: string = '';
  expiresIn: number = 900;
  interval: number = 5;
}

export const KIMI_DEVICE_URL: string = 'https://auth.kimi.com/api/oauth/device_authorization';
export const KIMI_TOKEN_URL: string = 'https://auth.kimi.com/api/oauth/token';
export const KIMI_CLIENT_ID: string = '17e5f671-d194-4dfb-9706-5516cb48c098';
export const XAI_DISCOVERY: string = 'https://auth.x.ai/.well-known/openid-configuration';
export const XAI_CLIENT_ID: string = 'b1a00492-073a-47ea-816f-4c329264a828';
export const DEVICE_GRANT: string = 'urn:ietf:params:oauth:grant-type:device_code';

export function httpsHost(url: string): string {
  const lower = url.trim().toLowerCase();
  if (!lower.startsWith('https://')) {
    return '';
  }
  const hostPort = url.trim().substring('https://'.length).split('/')[0];
  return hostPort.split(':')[0].toLowerCase();
}

export function hostEndsWith(host: string, suffix: string): boolean {
  const h = host.trim().toLowerCase();
  const s = suffix.trim().toLowerCase();
  return h === s || h.endsWith(`.${s}`);
}

export function parseDeviceAuth(json: object): DeviceAuth | null {
  const obj = json as Record<string, Object>;
  const deviceCode = `${obj['device_code'] ?? ''}`;
  const userCode = `${obj['user_code'] ?? ''}`;
  let uri = `${obj['verification_uri_complete'] ?? ''}`;
  if (uri.length === 0) {
    uri = `${obj['verification_uri'] ?? ''}`;
  }
  if (uri.length === 0) {
    uri = `${obj['verification_url'] ?? ''}`;
  }
  if (!deviceCode || !userCode || !uri) {
    return null;
  }
  const auth = new DeviceAuth();
  auth.deviceCode = deviceCode;
  auth.userCode = userCode;
  auth.verificationUri = uri;
  auth.expiresIn = Number(obj['expires_in'] ?? 900) || 900;
  auth.interval = Number(obj['interval'] ?? 5) || 5;
  return auth;
}

export function classifyDevicePoll(json: object, httpOk: boolean): string {
  const obj = json as Record<string, Object>;
  const token = `${obj['access_token'] ?? ''}`;
  if (httpOk && token.length > 0) {
    return 'ok';
  }
  const error = `${obj['error'] ?? ''}`.toLowerCase();
  if (error === 'authorization_pending') {
    return 'pending';
  }
  if (error === 'slow_down') {
    return 'slow';
  }
  if (error === 'access_denied') {
    return 'denied';
  }
  if (error === 'expired_token') {
    return 'expired';
  }
  return 'fatal';
}

export function accessTokenFromJson(json: object): string {
  return `${(json as Record<string, Object>)['access_token'] ?? ''}`;
}

export function thinkingLabel(level: string): string {
  if (level === 'low') {
    return '思考低';
  }
  if (level === 'medium') {
    return '思考中';
  }
  if (level === 'high') {
    return '思考高';
  }
  return '思考关';
}

export const CODEX_RESPONSES_URL: string = 'https://chatgpt.com/backend-api/codex/responses';
export const CODEX_CLIENT_VERSION: string = '0.144.1';

export function usesCodexResponses(type: string, credential: string, root: string): boolean {
  if (type !== 'openAI' || credential !== 'oauth') {
    return false;
  }
  const host = rootHost(root);
  return host.length === 0 || host === 'api.openai.com' || host === 'chatgpt.com';
}

export function rootHost(root: string): string {
  const raw = root.trim().toLowerCase().replace(/^https?:\/\//, '');
  return raw.split('/')[0].split(':')[0];
}

export function splitResponsesIds(combined: string): string[] {
  const sep = combined.indexOf('|');
  if (sep < 0) {
    return [combined, ''];
  }
  return [combined.substring(0, sep), combined.substring(sep + 1)];
}

export function combineResponsesIds(callId: string, fcId: string): string {
  return fcId.length > 0 ? `${callId}|${fcId}` : callId;
}

export function capResponsesId(id: string): string {
  return id.length <= 64 ? id : id.substring(0, 64);
}

export function responsesInputJson(turns: LoopTurn[]): string {
  const rows: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.role === 'tool') {
      const ids = splitResponsesIds(turn.toolCallId);
      rows.push(`{"type":"function_call_output","call_id":${JSON.stringify(capResponsesId(ids[0]))},"output":${JSON.stringify(turn.content)}}`);
      continue;
    }
    if (turn.calls.length > 0) {
      if (turn.content.length > 0) {
        rows.push(`{"role":"assistant","content":${JSON.stringify(turn.content)}}`);
      }
      for (let j = 0; j < turn.calls.length; j++) {
        const ids = splitResponsesIds(turn.calls[j].id);
        const callId = capResponsesId(ids[0].length > 0 ? ids[0] : `call_${j}`);
        const tail = callId.length > 24 ? callId.substring(callId.length - 24) : callId;
        const fcId = capResponsesId(ids[1].length > 0 ? ids[1] : `fc_syn_${tail}`);
        rows.push(`{"type":"function_call","id":${JSON.stringify(fcId)},"call_id":${JSON.stringify(callId)},"name":${JSON.stringify(turn.calls[j].name)},"arguments":${JSON.stringify(turn.calls[j].args)}}`);
      }
      continue;
    }
    if (turn.imageB64.length > 0) {
      const mime = turn.imageMime.length > 0 ? turn.imageMime : 'image/jpeg';
      rows.push(`{"role":${JSON.stringify(turn.role)},"content":[{"type":"input_text","text":${JSON.stringify(turn.content)}},{"type":"input_image","image_url":"data:${mime};base64,${turn.imageB64}"}]}`);
      continue;
    }
    rows.push(`{"role":${JSON.stringify(turn.role)},"content":${JSON.stringify(turn.content)}}`);
  }
  return `[${rows.join(',')}]`;
}

export function responsesToolSchemaJson(): string {
  const rows = JSON.parse(localToolSchemaJson()) as Object[];
  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i] as Record<string, Object>;
    const fn = item['function'] as Record<string, Object>;
    out.push(`{"type":"function","name":${JSON.stringify(fn['name'])},"description":${JSON.stringify(fn['description'])},"parameters":${JSON.stringify(fn['parameters'])}}`);
  }
  return `[${out.join(',')}]`;
}

export function responsesBodyJson(model: string, systemPrompt: string, turns: LoopTurn[],
  thinking: string): string {
  const effort = thinking.trim().length > 0 ? thinking.trim() : 'low';
  let cache = 'default';
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role === 'user' && turns[i].content.trim().length > 0) {
      cache = turns[i].content.trim().substring(0, 80);
      break;
    }
  }
  return `{"model":${JSON.stringify(model)},"stream":true,"store":false,"parallel_tool_calls":true,"prompt_cache_key":${JSON.stringify(cache)},"include":["reasoning.encrypted_content"],"reasoning":{"effort":${JSON.stringify(effort)},"summary":"auto"},"instructions":${JSON.stringify(systemPrompt)},"tools":${responsesToolSchemaJson()},"tool_choice":"auto","input":${responsesInputJson(turns)}}`;
}

export function responsesDeltaFromJson(json: object): string {
  const obj = json as Record<string, Object>;
  if (`${obj['type'] ?? ''}` === 'response.output_text.delta') {
    return `${obj['delta'] ?? ''}`;
  }
  return '';
}

export function responsesErrorFromJson(json: object): string {
  const obj = json as Record<string, Object>;
  if (`${obj['type'] ?? ''}` === 'response.failed') {
    const resp = obj['response'] as Record<string, Object> | undefined;
    const err = resp ? resp['error'] as Record<string, Object> | undefined : undefined;
    const text = `${err ? err['message'] ?? '' : ''}`.trim();
    return text.length > 0 ? text : 'response.failed';
  }
  if (`${obj['type'] ?? ''}` === 'error') {
    return `${obj['message'] ?? ''}`.trim();
  }
  return '';
}

export function applyResponsesToolDelta(acc: ToolCall[], json: object): ToolCall[] {
  const obj = json as Record<string, Object>;
  const type = `${obj['type'] ?? ''}`;
  const next: ToolCall[] = [];
  for (let i = 0; i < acc.length; i++) {
    const copy = new ToolCall();
    copy.id = acc[i].id;
    copy.name = acc[i].name;
    copy.args = acc[i].args;
    next.push(copy);
  }
  if (type === 'response.output_item.added') {
    const item = obj['item'] as Record<string, Object> | undefined;
    if (item && `${item['type'] ?? ''}` === 'function_call') {
      const itemId = `${item['id'] ?? ''}`;
      const callId = `${item['call_id'] ?? ''}`;
      const name = `${item['name'] ?? ''}`;
      if (itemId.length > 0 && callId.length > 0 && name.length > 0) {
        const row = new ToolCall();
        row.id = combineResponsesIds(callId, itemId);
        row.name = name;
        row.args = `${item['arguments'] ?? ''}`;
        next.push(row);
      }
    }
    return next;
  }
  if (type === 'response.function_call_arguments.delta') {
    const itemId = `${obj['item_id'] ?? ''}`;
    const delta = `${obj['delta'] ?? ''}`;
    for (let i = 0; i < next.length; i++) {
      if (next[i].id.endsWith(`|${itemId}`) || next[i].id === itemId) {
        next[i].args += delta;
      }
    }
    return next;
  }
  if (type === 'response.output_item.done') {
    const item = obj['item'] as Record<string, Object> | undefined;
    if (item && `${item['type'] ?? ''}` === 'function_call') {
      const itemId = `${item['id'] ?? ''}`;
      const args = `${item['arguments'] ?? ''}`;
      for (let i = 0; i < next.length; i++) {
        if ((next[i].id.endsWith(`|${itemId}`) || next[i].id === itemId) && args.length > 0) {
          next[i].args = args;
        }
      }
    }
  }
  return next;
}

export function accountIdFromIdToken(token: string): string {
  const parts = token.split('.');
  if (parts.length < 2) {
    return '';
  }
  try {
    let raw = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (raw.length % 4 !== 0) {
      raw += '=';
    }
    const helper = new util.Base64Helper();
    const bytes = helper.decodeSync(raw);
    const text = util.TextDecoder.create('utf-8', { ignoreBOM: true }).decodeToString(bytes);
    const obj = JSON.parse(text) as Record<string, Object>;
    return `${obj['chatgpt_account_id'] ?? ''}`;
  } catch (_err) {
    return '';
  }
}
