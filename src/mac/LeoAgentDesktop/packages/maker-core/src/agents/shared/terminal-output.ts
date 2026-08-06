/**
 * Claude Code / Codex 共享的终端输出处理工具。
 *
 * agent 的命令输出会进入 host 侧展示、落库、搜索、复制和远端同步链路。
 * 这些链路需要纯文本；终端样式只在真人直接看终端时有价值。
 */

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const OSC = String.fromCharCode(0x9d);
const ST = String.fromCharCode(0x9c);
const DCS = String.fromCharCode(0x90);
const PM = String.fromCharCode(0x9e);
const APC = String.fromCharCode(0x9f);
const CSI = String.fromCharCode(0x9b);

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

const ESC_RE = escapeRegExp(ESC);
const BEL_RE = escapeRegExp(BEL);
const OSC_RE = escapeRegExp(OSC);
const ST_RE = escapeRegExp(ST);
const DCS_RE = escapeRegExp(DCS);
const PM_RE = escapeRegExp(PM);
const APC_RE = escapeRegExp(APC);
const CSI_RE = escapeRegExp(CSI);

const OSC_SEQUENCE_RE = new RegExp(`(?:${ESC_RE}\\]|${OSC_RE})[\\s\\S]*?(?:${BEL_RE}|${ESC_RE}\\\\|${ST_RE}|$)`, 'g');
const DCS_PM_APC_SEQUENCE_RE = new RegExp(`(?:${ESC_RE}[P^_]|${DCS_RE}|${PM_RE}|${APC_RE})[\\s\\S]*?(?:${ESC_RE}\\\\|${ST_RE}|$)`, 'g');
const CSI_SEQUENCE_RE = new RegExp(`(?:${ESC_RE}\\[|${CSI_RE})[0-?]*[ -/]*[@-~]`, 'g');
const ESC_SEQUENCE_RE = new RegExp(`${ESC_RE}[ -/]*[0-~]`, 'g');

function stripNonNewlineC0Controls(text: string): string {
  let chunkStart = 0;
  let output = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const shouldStrip = code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
    if (!shouldStrip) continue;
    if (chunkStart < i) output += text.slice(chunkStart, i);
    chunkStart = i + 1;
  }
  if (chunkStart === 0) return text;
  return `${output}${text.slice(chunkStart)}`;
}

export function stripTerminalControlSequences(text: string): string {
  if (!text) return text;
  const withoutTerminalSequences = text
    .replace(OSC_SEQUENCE_RE, '')
    .replace(DCS_PM_APC_SEQUENCE_RE, '')
    .replace(CSI_SEQUENCE_RE, '')
    .replace(ESC_SEQUENCE_RE, '')
    .replace(/\r\n?/g, '\n');
  return stripNonNewlineC0Controls(withoutTerminalSequences);
}

export function applyPlainTextTerminalEnv(env: Record<string, string>): void {
  if (env.NO_COLOR === undefined) env.NO_COLOR = '1';
  if (env.CLICOLOR === undefined) env.CLICOLOR = '0';
  if (env.FORCE_COLOR === undefined) env.FORCE_COLOR = '0';
  if (env.TERM === undefined) env.TERM = 'dumb';
  if (env.PSStyle__OutputRendering === undefined) env.PSStyle__OutputRendering = 'PlainText';
}
