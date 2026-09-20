import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LEOAGENT_HOME } from './leoagent-home.js';
import { applySessionRule } from './session-rule.js';
import { expandSessionCwd, sessionCwdAllowed } from './session-workspace.js';

export const CWD_RULE_MAX = 400;

export function clipCwdRule(raw: string): string {
  return raw.replace(/\u0000/g, '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim().slice(0, CWD_RULE_MAX);
}

export function applyCwdRule(text: string, rule: string): string {
  const body = text.replace(/\u0000/g, '').trim();
  const note = clipCwdRule(rule);
  if (!note || !body) return body;
  if (body.includes(note)) return body;
  return `【目录规矩】\n${note}\n\n${body}`;
}

export function applyOutgoingRules(text: string, sessionRule: string, cwdRule: string): string {
  return applyCwdRule(applySessionRule(text, sessionRule), cwdRule);
}

function cwdRulesRoot(): string {
  const fromEnv = (process.env.LEOAGENT_HOME || '').trim();
  const home = fromEnv ? fromEnv.replace(/^~(?=$|\/)/, os.homedir()) : LEOAGENT_HOME;
  return path.join(home, 'cwd-rules');
}

function cwdKey(cwd: string): string {
  const resolved = path.resolve(expandSessionCwd(cwd));
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch { /* 目录还没建也要能记下 */ }
  return crypto.createHash('sha256').update(real).digest('hex').slice(0, 32);
}

export function cwdRulePath(cwd: string): string {
  return path.join(cwdRulesRoot(), `${cwdKey(cwd)}.rule`);
}

export function readCwdRuleSidecar(cwd: string): string {
  try {
    return clipCwdRule(fs.readFileSync(cwdRulePath(cwd), 'utf8'));
  } catch {
    return '';
  }
}

export function writeCwdRuleSidecar(cwd: string, rule: string): string {
  if (!sessionCwdAllowed(cwd)) throw new Error('这个目录不能写规矩');
  const next = clipCwdRule(rule);
  const dest = cwdRulePath(cwd);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  if (!next) {
    try { fs.unlinkSync(dest); } catch { /* already gone */ }
    return '';
  }
  fs.writeFileSync(dest, next, { encoding: 'utf8', mode: 0o600 });
  return next;
}
