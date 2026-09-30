import { LocalChatMessage, LoopTurn, HISTORY_CHAR_BUDGET, trimHistory } from './LocalProtocol';
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
      // 同一角色连着两条(带工具的一轮里前后两段回答、失败后又发了一句)合成一条:有的服务商不收。
      const prev = out.length > 0 ? out[out.length - 1] : null;
      if (prev && prev.role === line.role && prev.imageB64.length === 0 && line.imageB64.length === 0) {
        prev.content = `${prev.content}\n\n${content}`;
        continue;
      }
      const turn = new LoopTurn();
      turn.role = line.role;
      turn.content = content;
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
