/**
 * contacts/vcard.ts — 零依赖 vCard(3.0/4.0, 兼容 Apple 导出)解析器。
 *
 * 只提取通讯录导入需要的字段(FN/N/EMAIL/TEL/ORG/TITLE/NOTE), 归一化成
 * ImportContactRecord。设计约束:
 *  - 跨平台导入的公共通道(Windows 没有可编程系统通讯录, vCard 是事实标准)
 *  - 容错优先: 单条损坏跳过, 不让一张坏卡毁掉整批导入
 *  - 不提取 UID 当锚点: Apple 导出的 .vcf 默认不含稳定 UID, 伪锚点比没有更糟
 */

import type { ContactProfile, ImportContactRecord, RelatedContactRef } from './types.js';

/**
 * 任职语义判定: 关系动词命中雇佣类词汇(中文常用写法 + 英文 employ / works at)
 * 才算雇主关系。关系动词是 free-form 文本, 客户/供应商/投资方/成员 这类指向
 * org 的边不是雇佣关系, 不该被导出成 公司/职位 字段; 匹配不到宁可不写 —
 * 导出侧"只增不删"语义下欠导出安全, 错导出会污染系统联系人卡。
 */
const EMPLOYMENT_RELATION_PATTERN = /任职|就职|在职|供职|入职|works?\s+at|employ/i;

/**
 * 取档案的雇主关系(动词命中任职语义、指向 org 的出边)。relations 按 created_at
 * 升序返回, 这里取**最后一条**命中 = 最新任职 — 换工作没删旧任职关系时, 导出的
 * 公司/职位应是现雇主而不是老东家; 无命中返回 undefined。
 */
export function findEmploymentRelation(p: ContactProfile): RelatedContactRef | undefined {
  let latest: RelatedContactRef | undefined;
  for (const r of p.relations) {
    if (r.direction === 'out' && r.kind === 'org' && EMPLOYMENT_RELATION_PATTERN.test(r.relation)) {
      latest = r;
    }
  }
  return latest;
}

/** 解析 .vcf 文本为导入记录列表. 损坏的卡片静默跳过 */
export function parseVCards(text: string): ImportContactRecord[] {
  const records: ImportContactRecord[] = [];
  for (const block of splitCards(unfoldLines(text))) {
    try {
      const rec = parseCard(block);
      if (rec) records.push(rec);
    } catch {
      // 单卡损坏跳过
    }
  }
  return records;
}

/** RFC 6350 折行展开: CRLF + (space|tab) 是续行 */
function unfoldLines(text: string): string[] {
  const raw = text.split(/\r\n|\r|\n/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function splitCards(lines: string[]): string[][] {
  const cards: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VCARD') {
      current = [];
    } else if (upper === 'END:VCARD') {
      if (current) cards.push(current);
      current = null;
    } else if (current) {
      current.push(line);
    }
  }
  return cards;
}

interface Prop {
  name: string;
  params: Map<string, string[]>;
  value: string;
}

/** 解析单行属性: [group.]NAME[;PARAM=v[,v2]]*:value */
function parseProp(line: string): Prop | null {
  const colon = findUnquoted(line, ':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');
  let name = parts[0]!.toUpperCase();
  const dot = name.indexOf('.');
  if (dot >= 0) name = name.slice(dot + 1); // 去 item1. 分组前缀
  const params = new Map<string, string[]>();
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    // 裸参数(vCard 2.1 风格 "TEL;WORK:...")按 TYPE 收
    const key = eq >= 0 ? p.slice(0, eq).toUpperCase() : 'TYPE';
    const vals = (eq >= 0 ? p.slice(eq + 1) : p)
      .split(',')
      .map((v) => v.replace(/^"|"$/g, '').trim())
      .filter(Boolean);
    params.set(key, [...(params.get(key) ?? []), ...vals]);
  }
  return { name, params, value };
}

function findUnquoted(s: string, ch: string): number {
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') inQuote = !inQuote;
    else if (s[i] === ch && !inQuote) return i;
  }
  return -1;
}

/** 文本值反转义(RFC 6350): \\n \\, \\; \\\\ — 单趟处理, 避免 "\\\\n"(字面反斜杠+n)被两趟替换错还原成换行 */
function unescapeText(v: string): string {
  return v.replace(/\\(.)/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** 按未转义分隔符切分(CATEGORIES 等列表值): 跳过 \\, 这类转义对, 不吃掉转义内容 */
function splitUnescaped(v: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < v.length; i += 1) {
    const c = v[i]!;
    if (c === '\\' && i + 1 < v.length) {
      cur += c + v[i + 1];
      i += 1;
      continue;
    }
    if (c === sep) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** TYPE 参数 → 简洁 label(work/home/mobile), 其余原样小写 */
function labelFromParams(params: Map<string, string[]>): string | undefined {
  const types = (params.get('TYPE') ?? []).map((t) => t.toLowerCase()).filter((t) => t !== 'pref' && t !== 'internet' && t !== 'voice');
  return types[0];
}

function parseCard(lines: string[]): ImportContactRecord | null {
  let fn = '';
  let n = '';
  let isCompany = false;
  let org: string | undefined;
  let title: string | undefined;
  let note: string | undefined;
  const emails: ImportContactRecord['emails'] = [];
  const phones: ImportContactRecord['phones'] = [];
  const identities: NonNullable<ImportContactRecord['identities']> = [];
  const groups: string[] = [];

  for (const line of lines) {
    const prop = parseProp(line);
    if (!prop || !prop.value) continue;
    // 本产品导出的平台身份扩展(X-XDMAKER-FEISHU 等)回读, 保证 export→import 不丢身份。
    // apple-contacts 锚点例外: 导出侧已跳过, 但旧版本导出的 vcf / 外来 vcf 仍可能带 —
    // 别机 Contacts.app 的死锚导回来会被 export_system 当更新目标(byId 失配 missing),
    // 还会让带同锚值的两个人被去重误并, 导入侧同样丢弃
    if (prop.name.startsWith('X-XDMAKER-')) {
      const platform = prop.name.slice('X-XDMAKER-'.length).toLowerCase();
      const value = unescapeText(prop.value).trim();
      if (platform && value && platform !== 'apple-contacts') identities.push({ platform, value });
      continue;
    }
    switch (prop.name) {
      case 'FN':
        fn = unescapeText(prop.value).trim();
        break;
      case 'N': {
        // 姓;名;中间名;前缀;后缀 → CJK 姓名直接拼, 拉丁反转 "名 姓"
        // (与 ORG 同款: 未转义分号才是组件分隔, 组件内 \; 反转义后保留)
        const parts = splitUnescaped(prop.value, ';').map((p) => unescapeText(p).trim());
        const family = parts[0] ?? '';
        const given = parts[1] ?? '';
        if (family || given) {
          n = /[\u3400-\u9FFF\uF900-\uFAFF]/.test(family + given) ? `${family}${given}` : `${given} ${family}`.trim();
        }
        break;
      }
      case 'ORG':
        // 先按未转义分号切组件再反转义 — 公司名含 \; 时裸 split 会把
        // "Foo\;Bar" 断成 "Foo\", 备份还原挂错组织
        org = unescapeText(splitUnescaped(prop.value, ';')[0] ?? '').trim() || undefined;
        break;
      case 'TITLE':
        title = unescapeText(prop.value).trim() || undefined;
        break;
      case 'NOTE':
        note = unescapeText(prop.value).trim() || undefined;
        break;
      // 分组回读(本产品导出写 CATEGORIES; Apple/Google 导出同字段), 逗号分隔、
      // 值内逗号以 \, 转义 — export→import 分组不丢
      case 'CATEGORIES':
        for (const g of splitUnescaped(prop.value, ',')) {
          const name = unescapeText(g).trim();
          if (name && !groups.includes(name)) groups.push(name);
        }
        break;
      // 公司卡片标记: Apple 导出 X-ABShowAs:COMPANY; vCard 4.0 KIND:org
      case 'X-ABSHOWAS':
        if (prop.value.trim().toUpperCase() === 'COMPANY') isCompany = true;
        break;
      case 'KIND':
        if (/^org/i.test(prop.value.trim())) isCompany = true;
        break;
      case 'EMAIL': {
        const v = prop.value.trim();
        if (v) {
          const label = labelFromParams(prop.params);
          emails.push({ value: v, ...(label ? { label } : {}) });
        }
        break;
      }
      case 'TEL': {
        const v = prop.value.trim();
        if (v) {
          const label = labelFromParams(prop.params);
          phones.push({ value: v, ...(label ? { label } : {}) });
        }
        break;
      }
      default:
        break;
    }
  }

  // 无人名但有公司名的卡片按公司处理(常见: 商家/服务号存成联系人)
  const displayName = fn || n || (isCompany || !n ? org ?? '' : '');
  if (!displayName) return null;
  if (!fn && !n && org) isCompany = true;
  return {
    displayName,
    ...(isCompany ? { kind: 'org' as const } : {}),
    emails,
    phones,
    ...(identities.length > 0 ? { identities } : {}),
    ...(org ? { org } : {}),
    ...(title ? { title } : {}),
    ...(note ? { note } : {}),
    ...(groups.length > 0 ? { groups } : {}),
  };
}

// ── 序列化(导出) ─────────────────────────────────────────────────────────

/** RFC 6350 §3.2 行折叠: 内容行超 75 字节时以 CRLF+SPACE 续行; 按码点切, 不撕开多字节 UTF-8 */
function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (curBytes + b > 75 && cur) {
      out.push(cur);
      cur = ' ';
      curBytes = 1;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

/** RFC 6350 文本值转义 */
function escapeText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\r?\n|\r/g, '\\n');
}

/** TYPE 参数值净化: 只留 token 字符(防 label 含 ;: 换行注入伪造行), 空则不输出 TYPE */
function sanitizeTypeLabel(label: string): string {
  return label.toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

/**
 * 把档案序列化成 vCard 3.0 文本(导出/备份/迁移用)。
 * 只导出可公开的结构化字段: 姓名/邮箱/电话/组织与职位(取第一条指向 org 的
 * 任职类关系)/一行简介(NOTE)/分组(CATEGORIES)。叙事与 agent 指令是私有
 * 上下文, 永不出库。
 */
export function serializeVCards(profiles: ContactProfile[]): string {
  const lines: string[] = [];
  for (const p of profiles) {
    lines.push('BEGIN:VCARD', 'VERSION:3.0');
    lines.push(`N:${escapeText(p.displayName)};;;;`);
    lines.push(`FN:${escapeText(p.displayName)}`);
    if (p.kind === 'org') {
      // 公司卡标记双写: vCard 4.0 KIND + Apple X-ABShowAs, round-trip 与 Apple 导入都认;
      // ORG 写自己的名字(Apple 公司卡语义), 不再找任职关系
      lines.push('KIND:org', 'X-ABSHOWAS:COMPANY');
      lines.push(`ORG:${escapeText(p.displayName)}`);
    } else {
      const employment = findEmploymentRelation(p);
      if (employment) {
        lines.push(`ORG:${escapeText(employment.displayName)}`);
        if (employment.note) lines.push(`TITLE:${escapeText(employment.note)}`);
      }
    }
    for (const i of p.identities) {
      const typeParam = i.label && sanitizeTypeLabel(i.label) ? `;TYPE=${sanitizeTypeLabel(i.label)}` : '';
      if (i.platform === 'email') {
        lines.push(`EMAIL${typeParam}:${escapeText(i.value)}`);
      } else if (i.platform === 'phone') {
        lines.push(`TEL${typeParam}:${escapeText(i.value)}`);
      }
      // apple-contacts 锚点是本机 Contacts.app 的对账 id, 换机/异库还原后是死值 —
      // 带出去再导回会让 contacts_export_system 拿它当更新目标, byId 失配整条跳过
      // (missing), 联系人永远写不进新机系统通讯录; 便携备份不携带机器本地锚点
      else if (i.platform !== 'apple-contacts') {
        // 其它平台身份(feishu/github/...)vCard 无标准字段, 走 X- 扩展保信息
        lines.push(`X-XDMAKER-${i.platform.toUpperCase()}:${escapeText(i.value)}`);
      }
    }
    if (p.summary) lines.push(`NOTE:${escapeText(p.summary)}`);
    if (p.groups.length > 0) lines.push(`CATEGORIES:${p.groups.map((g) => escapeText(g.name)).join(',')}`);
    lines.push('END:VCARD');
  }
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
