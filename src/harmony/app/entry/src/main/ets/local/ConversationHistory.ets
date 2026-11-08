import { LocalChatMessage, chatImages, ToolCall, LoopTurn, HISTORY_CHAR_BUDGET, trimHistory } from './LocalProtocol';
import { TextLine, STOPPED_NOTE, lastSummaryIndex, resumeNote, attachedFilesBlock, summaryWrapper } from './AgentText';

/** 本机和远控共用同一份已压缩会话历史规则，避免每次 send 重置模型上下文。 */
export function conversationHistory(messages: LocalChatMessage[]): LoopTurn[] {
    const all = messages.map((row: LocalChatMessage) => {
      const line = new TextLine();
      line.role = row.role; line.text = row.text; line.kind = row.kind; line.at = row.at;
      return line;
    });
    const start = lastSummaryIndex(all);
    const out: LoopTurn[] = [];
    const results = syncedResultIds(messages.slice(start + 1));
    for (let i = start + 1; i < messages.length; i++) {
      const line = messages[i];
      if (line.role !== 'user' && line.role !== 'assistant') {
        continue;
      }
      let content = line.text;
      if (line.kind === 'resume') {
        content = resumeNote(all, i);
      } else if (line.kind === 'partial') {
        content = `${line.text}\n\n${STOPPED_NOTE}`;
      }
      if (line.files.length > 0) {
        content = `${content}\n\n${attachedFilesBlock(line.files)}`;
      }
      if (appendSyncedTools(out, line, results)) continue;
      // 同一角色连着两条(带工具的一轮里前后两段回答、失败后又发了一句)合成一条:有的服务商不收。
      const prev = out.length > 0 ? out[out.length - 1] : null;
      if (prev && prev.calls.length === 0 && prev.role === line.role && prev.images.length === 0 && chatImages(line.images, line.imageB64, line.imageMime, line.imagePath).length === 0) {
        prev.content = `${prev.content}\n\n${content}`;
        continue;
      }
      const turn = new LoopTurn();
      turn.role = line.role;
      turn.content = content;
      turn.images = chatImages(line.images, line.imageB64, line.imageMime, line.imagePath);
      turn.imageB64 = line.imageB64;
      turn.imageMime = line.imageMime.length > 0 ? line.imageMime : 'image/jpeg';
      out.push(turn);
    }
    if (start >= 0) {
      const wrapped = summaryWrapper(messages[start].text);
      if (out.length > 0 && out[0].role === 'user') {
        out[0].content = `${wrapped}\n\n${out[0].content}`;
      } else {
        const head = new LoopTurn();
        head.role = 'user';
        head.content = wrapped;
        out.unshift(head);
      }
    }
    return trimHistory(out, HISTORY_CHAR_BUDGET);
  }

class SyncedPart { type: string = ''; value: Object = ''; }
class SyncedToolUse { toolUseId: string = ''; name: string = ''; input: string = ''; }
class SyncedToolResult { toolUseId: string = ''; output: string = ''; }

function syncedParts(line: LocalChatMessage): SyncedPart[] {
  if (!line.syncPartsJson || line.syncText !== line.text) return [];
  try { const parts = JSON.parse(line.syncPartsJson) as SyncedPart[]; return Array.isArray(parts) ? parts : []; }
  catch (_error) { return []; }
}

function syncedResultIds(messages: LocalChatMessage[]): Set<string> {
  const ids: Set<string> = new Set();
  const uses: Set<string> = new Set();
  for (let i = 0; i < messages.length; i++) {
    const parts = syncedParts(messages[i]);
    for (let j = 0; j < parts.length; j++) {
      if (parts[j].type === 'toolUse') {
        const use = parts[j].value as SyncedToolUse;
        if (use && typeof use.toolUseId === 'string') uses.add(use.toolUseId);
      }
      if (parts[j].type !== 'toolResult') continue;
      const result = parts[j].value as SyncedToolResult;
      if (result && typeof result.toolUseId === 'string' && uses.has(result.toolUseId)) ids.add(result.toolUseId);
    }
  }
  return ids;
}

/** 已同步的历史工具只还原上下文，不进入执行器。缺少配对结果的调用保持普通文字。 */
function appendSyncedTools(out: LoopTurn[], line: LocalChatMessage, results: Set<string>): boolean {
  const parts = syncedParts(line);
  const uses = parts.filter((part: SyncedPart) => part.type === 'toolUse');
  const outputs = parts.filter((part: SyncedPart) => part.type === 'toolResult');
  if (!uses.length && !outputs.length) return false;
  const turn = new LoopTurn(); turn.role = line.role;
  turn.content = parts.filter((part: SyncedPart) => part.type === 'text' && typeof part.value === 'string').map((part: SyncedPart) => part.value as string).join('\n');
  for (let i = 0; i < uses.length; i++) {
    const use = uses[i].value as SyncedToolUse;
    if (!use || typeof use.toolUseId !== 'string' || typeof use.name !== 'string' || typeof use.input !== 'string' || !results.has(use.toolUseId)) continue;
    const call = new ToolCall(); call.id = use.toolUseId; call.name = use.name; call.args = use.input; turn.calls.push(call);
  }
  if (turn.calls.length || (turn.content && !outputs.length)) out.push(turn);
  for (let i = 0; i < outputs.length; i++) {
    const output = outputs[i].value as SyncedToolResult;
    if (!output || typeof output.toolUseId !== 'string' || typeof output.output !== 'string') continue;
    const caller = out.find((entry: LoopTurn) => entry.calls.some((call: ToolCall) => call.id === output.toolUseId));
    if (!caller || out.some((entry: LoopTurn) => entry.role === 'tool' && entry.toolCallId === output.toolUseId)) continue;
    const tool = new LoopTurn(); tool.role = 'tool'; tool.toolCallId = output.toolUseId;
    tool.toolName = caller.calls.find((call: ToolCall) => call.id === output.toolUseId)?.name ?? ''; tool.content = output.output; out.push(tool);
  }
  if (outputs.length && turn.content && !turn.calls.length) out.push(turn);
  if (!turn.calls.length && !turn.content && !outputs.length) { const pending = new LoopTurn(); pending.role = line.role; pending.content = line.text; out.push(pending); }
  return true;
}
