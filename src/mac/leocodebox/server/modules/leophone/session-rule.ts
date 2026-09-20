import fs from 'node:fs';
import path from 'node:path';

export const SESSION_RULE_MAX = 400;

export function clipSessionRule(raw: string): string {
  return raw.replace(/\u0000/g, '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim().slice(0, SESSION_RULE_MAX);
}

export function applySessionRule(text: string, rule: string): string {
  const body = text.replace(/\u0000/g, '').trim();
  const note = clipSessionRule(rule);
  if (!note || !body) return body;
  if (body.includes(note)) return body;
  return `【会话规矩】\n${note}\n\n${body}`;
}

export function ruleSidecarPath(logPath: string): string {
  return logPath.replace(/\.ndjson$/i, '.rule');
}

export function readRuleSidecar(logPath: string): string {
  try {
    return clipSessionRule(fs.readFileSync(ruleSidecarPath(logPath), 'utf8'));
  } catch {
    return '';
  }
}

export function writeRuleSidecar(logPath: string, rule: string): string {
  const next = clipSessionRule(rule);
  const dest = ruleSidecarPath(logPath);
  if (path.basename(dest).includes('..')) throw new Error('规矩文件不合法');
  if (!next) {
    try { fs.unlinkSync(dest); } catch { /* already gone */ }
    return '';
  }
  fs.writeFileSync(dest, next, 'utf8');
  return next;
}
