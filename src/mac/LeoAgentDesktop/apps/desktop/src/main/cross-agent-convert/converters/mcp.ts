/**
 * mcp converter: .mcp.json (Claude) ↔ .codex/config.toml [mcp_servers] (Codex)
 *
 * 双向 merge：按 server name (key) 已存在跳过，缺失追加。绝不覆盖现有 value。
 *
 * 数据形态参考：
 *   .mcp.json:
 *     { "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }
 *   config.toml:
 *     [mcp_servers.<name>]
 *     command = "..."
 *     args = [...]
 *     [mcp_servers.<name>.env]
 *     KEY = "VAL"
 *
 * 安全策略：
 *  - 目标文件不存在 → 创建新文件（仅含 merge 进去的 key）
 *  - 目标文件存在 → parse → merge 缺失 key → stringify 写回
 *  - parse 失败 → 整体放弃（不动用户文件），返回 failed
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import type { MigrationItem, MigrationStepStatus } from '../types.js';

export interface ConvertOutcome {
  status: MigrationStepStatus;
  detail?: string;
}

interface McpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

type McpServerMap = Record<string, McpServer>;

async function readJsonIfExists(p: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === 'ENOENT') return null;
    throw err;
  }
}

async function readTomlIfExists(p: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    const parsed = parseToml(raw);
    return parsed as Record<string, unknown>;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === 'ENOENT') return null;
    throw err;
  }
}

function extractMcpServersFromJson(json: unknown): McpServerMap {
  if (!json || typeof json !== 'object') return {};
  const obj = json as Record<string, unknown>;
  // 标准 .mcp.json 形态：顶层 mcpServers 字段
  const ms = obj.mcpServers;
  if (ms && typeof ms === 'object' && !Array.isArray(ms)) return ms as McpServerMap;
  return {};
}

function extractMcpServersFromToml(toml: Record<string, unknown> | null): McpServerMap {
  if (!toml) return {};
  const ms = toml.mcp_servers;
  if (ms && typeof ms === 'object' && !Array.isArray(ms)) return ms as McpServerMap;
  return {};
}

function isDisabled(server: McpServer): boolean {
  return server.disabled === true;
}

/** to-codex: merge JSON's mcpServers → TOML's [mcp_servers.*] */
async function importJsonIntoToml(item: MigrationItem): Promise<ConvertOutcome> {
  const sourceJson = await readJsonIfExists(item.source);
  if (!sourceJson) return { status: 'skipped', detail: '源 .mcp.json 不存在' };
  const sourceServers = extractMcpServersFromJson(sourceJson);
  const sourceKeys = Object.keys(sourceServers);
  if (sourceKeys.length === 0) return { status: 'skipped', detail: '源无 mcpServers' };

  let target: Record<string, unknown>;
  try {
    target = (await readTomlIfExists(item.target)) ?? {};
  } catch (err) {
    return { status: 'failed', detail: `目标 TOML 解析失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  const existing = extractMcpServersFromToml(target);
  const mergedServers: McpServerMap = { ...existing };

  let added = 0;
  let skippedDisabled = 0;
  for (const [name, server] of Object.entries(sourceServers)) {
    if (isDisabled(server)) {
      skippedDisabled += 1;
      continue;
    }
    if (name in mergedServers) continue; // key 已存在 → 跳过
    mergedServers[name] = server;
    added += 1;
  }

  if (added === 0) {
    return {
      status: 'skipped',
      detail: skippedDisabled > 0 ? `已存在或 disabled (${skippedDisabled})` : '已存在',
    };
  }

  target.mcp_servers = mergedServers as unknown as Record<string, unknown>;

  await fs.mkdir(path.dirname(item.target), { recursive: true });
  await fs.writeFile(item.target, stringifyToml(target), 'utf8');
  return { status: 'success', detail: `新增 ${added} 个 server` };
}

/** to-claude: merge TOML's [mcp_servers.*] → JSON's mcpServers */
async function importTomlIntoJson(item: MigrationItem): Promise<ConvertOutcome> {
  let sourceToml: Record<string, unknown> | null;
  try {
    sourceToml = await readTomlIfExists(item.source);
  } catch (err) {
    return { status: 'failed', detail: `源 TOML 解析失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  const sourceServers = extractMcpServersFromToml(sourceToml);
  if (Object.keys(sourceServers).length === 0) return { status: 'skipped', detail: '源无 [mcp_servers]' };

  let targetJson: Record<string, unknown>;
  const existing = await readJsonIfExists(item.target);
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    targetJson = existing as Record<string, unknown>;
  } else {
    targetJson = {};
  }
  const existingServers = extractMcpServersFromJson(targetJson);
  const mergedServers: McpServerMap = { ...existingServers };

  let added = 0;
  for (const [name, server] of Object.entries(sourceServers)) {
    if (name in mergedServers) continue;
    mergedServers[name] = server;
    added += 1;
  }

  if (added === 0) return { status: 'skipped', detail: '已存在' };

  targetJson.mcpServers = mergedServers;
  await fs.mkdir(path.dirname(item.target), { recursive: true });
  await fs.writeFile(item.target, JSON.stringify(targetJson, null, 2), 'utf8');
  return { status: 'success', detail: `新增 ${added} 个 server` };
}

export async function convertMcp(item: MigrationItem): Promise<ConvertOutcome> {
  if (item.direction === 'to-codex') return importJsonIntoToml(item);
  return importTomlIntoJson(item);
}
