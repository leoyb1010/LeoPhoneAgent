/**
 * contacts/dedupe.ts — 同人识别与归并的确定性逻辑(规则 9: 代码保证, 不靠 prompt)。
 *
 * 三个能力:
 *  - findSimilar(store 调): 给一份"将要创建的档案", 找出疑似同人的既有档案
 *      - identity 级: (platform, value) 精确命中 → 就是同一个人(最高置信)
 *      - name 级: 显示名/别名归一化后 相等 / 互为子串(CJK) / token 包含(拉丁)
 *  - namesSimilar: 纯函数启发式, "Remy" vs "Remy Kim"、"周子墨" vs "子墨" 都算相似
 *  - scanDuplicatePairs: 全库两两扫描疑似重复对(维护工具/待确认队列消费)
 *
 * 边界: name 级只做"疑似"提示(同名不代表同人), 不自动合并; 自动归并只发生在
 * identity 精确命中(MCP 层 enrich 路径)。
 *
 * 性能: 名字归一化(正则)与 token Set 构建是两两比对的热路径, 全部预计算进
 * NormFacet; 批量导入用 NameSnapshot 把全表行+facets 缓存一次, 逐条追加新建行,
 * 避免每条记录重跑 SELECT 全表 + JSON.parse(2000 行库 500 条导入即百万次)。
 */

import type Database from 'better-sqlite3';

import { parseAliases } from './rows.js';
import {
  normalizeIdentityValue,
  normalizePlatform,
  type ContactKind,
  type ContactStatus,
  type CreateContactInput,
  type DuplicateCandidate,
  type DuplicatePair,
} from './types.js';

/** 名字归一化: 小写、去空白与常见分隔符 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s·.,_-]+/g, '');
}

function hasCjk(s: string): boolean {
  // 覆盖 CJK 扩展 A(U+3400-U+4DBF)+ 基本区(U+4E00-U+9FFF)+ 兼容表意(U+F900-U+FAFF),
  // 生僻姓名字漏判会让名字比对误走拉丁 token 路径
  return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(s);
}

/** 单个名字面的预计算形态(归一化串 + CJK 标记 + token 集), 比对热路径零正则 */
interface NormFacet {
  norm: string;
  cjk: boolean;
  toks: Set<string>;
}

function buildNormFacet(name: string): NormFacet {
  const norm = normalizeName(name);
  const toks = new Set(
    name
      .toLowerCase()
      .split(/[\s·.,_-]+/)
      .filter((t) => t.length > 0),
  );
  return { norm, cjk: hasCjk(norm), toks };
}

function normFacetsSimilar(a: NormFacet, b: NormFacet): boolean {
  if (!a.norm || !b.norm) return false;
  if (a.norm === b.norm) return true;
  if (a.cjk || b.cjk) {
    const [short, long] = a.norm.length <= b.norm.length ? [a, b] : [b, a];
    // 子串匹配只在短边含 CJK 时生效("子墨"⊂"周子墨");短边纯拉丁落回整词
    // token 对比 — 否则 "XD" 这种两字母别名会误命中 "XDMaker..." 任意包含串
    if (short.cjk) return short.norm.length >= 2 && long.norm.includes(short.norm);
  }
  const [small, big] = a.toks.size <= b.toks.size ? [a.toks, b.toks] : [b.toks, a.toks];
  if (small.size === 0) return false;
  for (const t of small) {
    if (!big.has(t)) return false;
  }
  return true;
}

/**
 * 两个名字是否"疑似同人":
 *  - 归一化后相等
 *  - CJK: 一方是另一方的子串(长度 ≥2, 防单字误伤) — "子墨" ⊂ "周子墨"
 *  - 拉丁: 一方的 token 集是另一方的子集 — "Remy" ⊆ "Remy Kim"
 */
export function namesSimilar(a: string, b: string): boolean {
  return normFacetsSimilar(buildNormFacet(a), buildNormFacet(b));
}

/** 一份档案的全部"名字面": 显示名 + 别名 */
export interface NameFacets {
  displayName: string;
  aliases: string[];
}

function prepareFacets(f: NameFacets): NormFacet[] {
  return [f.displayName, ...f.aliases].map(buildNormFacet);
}

function preparedSimilar(a: NormFacet[], b: NormFacet[]): boolean {
  for (const fa of a) {
    for (const fb of b) {
      if (normFacetsSimilar(fa, fb)) return true;
    }
  }
  return false;
}

/** 两份档案的名字面任意组合相似即疑似同人 */
export function profilesNameSimilar(a: NameFacets, b: NameFacets): boolean {
  return preparedSimilar(prepareFacets(a), prepareFacets(b));
}

// ── 名字面快照(批量导入的批内缓存) ───────────────────────────────────────

/** 全库名字面快照的单行: 行元数据 + 预计算 facets */
export interface NameSnapshotEntry {
  id: string;
  kind: ContactKind;
  displayName: string;
  status: ContactStatus;
  summary: string;
  facets: NormFacet[];
}

/** 可增量追加的全库名字面快照(import 管道批内共享) */
export type NameSnapshot = NameSnapshotEntry[];

const SCAN_ROW_CAP = 2000; // 两两扫描(O(n^2))的行数上限 — 只约束 scanDuplicatePairs, 不约束线性快照

interface NameRow {
  id: string;
  kind: string;
  display_name: string;
  aliases: string;
  status: string;
  summary: string;
}

/**
 * 加载全库名字面快照(不封顶), facets 一次性预计算。
 * findSimilar 对快照是线性扫描, 大库(万级)也只是每次建档多几毫秒; 这里封顶的话
 * 第 N 行之后的档案对查重完全隐身 — 大批量导入后重复档案静默漏检(cap 曾设 2000,
 * 恰好等于单批导入上限, 两批导入就能穿过)。O(n^2) 的两两扫描另行在
 * scanDuplicatePairs 里限行。
 */
export function loadNameSnapshot(db: Database.Database): NameSnapshot {
  const rows = db
    .prepare(`SELECT id, kind, display_name, aliases, status, summary FROM contacts`)
    .all() as NameRow[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as ContactKind,
    displayName: r.display_name,
    status: r.status as ContactStatus,
    summary: r.summary,
    facets: prepareFacets({ displayName: r.display_name, aliases: parseAliases(r.aliases) }),
  }));
}

/** 给"刚创建的档案"构造快照行(import 管道逐条追加, 保证批内后续记录能撞见它) */
export function buildSnapshotEntry(input: {
  id: string;
  kind: ContactKind;
  displayName: string;
  aliases?: string[];
  status: ContactStatus;
  summary?: string;
}): NameSnapshotEntry {
  return {
    id: input.id,
    kind: input.kind,
    displayName: input.displayName,
    status: input.status,
    summary: input.summary ?? '',
    facets: prepareFacets({ displayName: input.displayName, aliases: input.aliases ?? [] }),
  };
}

// ── 库级函数(store 薄委托) ───────────────────────────────────────────────

/**
 * 给"将要创建的档案"找疑似同人候选:
 *  identity 精确命中优先(= 同人, 调用方应走 enrich 而不是新建);
 *  name 级相似其次(疑似, 调用方应拦截让 agent 确认)。
 * snapshot 传入时用它做名字扫描(批量导入批内复用), 否则现场加载。
 */
export function findSimilarContacts(
  db: Database.Database,
  input: CreateContactInput,
  snapshot?: NameSnapshot,
): DuplicateCandidate[] {
  const out: DuplicateCandidate[] = [];
  const seen = new Set<string>();

  for (const i of input.identities ?? []) {
    let platform: string;
    try {
      platform = normalizePlatform(i.platform);
    } catch {
      continue; // 非法 platform 由 createContact 的正式校验报错
    }
    const normalized = normalizeIdentityValue(i.value, platform);
    if (!normalized) continue;
    const row = db
      .prepare(
        `SELECT c.id, c.kind, c.display_name, c.aliases, c.status, c.summary
         FROM contact_identities ci JOIN contacts c ON c.id = ci.contact_id
         WHERE ci.platform = ? AND ci.normalized_value = ?`,
      )
      .get(platform, normalized) as NameRow | undefined;
    if (row && !seen.has(row.id)) {
      seen.add(row.id);
      out.push({
        matchType: 'identity',
        contactId: row.id,
        displayName: row.display_name,
        kind: row.kind as ContactKind,
        status: row.status as ContactStatus,
        summary: row.summary,
        matchedIdentity: { platform, value: i.value },
      });
    }
  }

  const inputFacets = prepareFacets({ displayName: input.displayName, aliases: input.aliases ?? [] });
  // 名字比对跨 kind: 公司被错建成 person(或反之)是高频错档形态, 同名不同类
  // 必须暴露给调用方裁决, 不能靠类型隔离静默放行
  const entries = snapshot ?? loadNameSnapshot(db);
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    if (preparedSimilar(inputFacets, entry.facets)) {
      seen.add(entry.id);
      out.push({
        matchType: 'name',
        contactId: entry.id,
        displayName: entry.displayName,
        kind: entry.kind,
        status: entry.status,
        summary: entry.summary,
      });
    }
  }
  return out;
}

/** 全库疑似重复对扫描(名字面相似, 跨 kind — 错档类型也要暴露)。O(n²), 行数有 cap */
export function scanDuplicatePairs(db: Database.Database, limit = 50): DuplicatePair[] {
  // 两两扫描是 O(n^2), 行数封顶防御超大库把维护工具卡死(线性查重不受此限)
  const entries = loadNameSnapshot(db).slice(0, SCAN_ROW_CAP);
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < entries.length && pairs.length < limit; i++) {
    for (let j = i + 1; j < entries.length && pairs.length < limit; j++) {
      const a = entries[i]!;
      const b = entries[j]!;
      if (preparedSimilar(a.facets, b.facets)) {
        pairs.push({
          aId: a.id,
          aName: a.displayName,
          aKind: a.kind,
          bId: b.id,
          bName: b.displayName,
          bKind: b.kind,
        });
      }
    }
  }
  return pairs;
}
