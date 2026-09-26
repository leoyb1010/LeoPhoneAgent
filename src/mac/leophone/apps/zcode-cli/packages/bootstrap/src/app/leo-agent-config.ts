// ============================================================
// [leo] 读取 Leo agent 档位配置
// ============================================================
// 来源（后者覆盖前者）：
//   1. 用户配置 ~/.leophoneagent/cli/config.json 的 "leo" 段（与上游配置同一个文件，路径取
//      createConfig 实际加载的那个）；
//   2. 项目配置 zcode.json / .zcode/config.json 的 "leo" 段（与上游同一套发现逻辑）；
//   3. 环境变量 ZCODE_LEO_AGENT：同结构 JSON，便于 eval / 临时切换（例如强制全部 hashline）。
// 上游 config schema 是 passthrough，"leo" 段不会影响上游解析；这里单独读取，不改上游的配置合并链。
// 写错的字段只丢弃并给出 warning，不阻止 agent 启动。结构与语义见 core/src/tool/leo/model-profile.ts。

import { readFileSync } from "node:fs";
import type { ConfigResult } from "@zcode/adapters/config";
import { mergeLeoAgentSettings, parseLeoAgentSettings, type LeoAgentSettings } from "@zcode/core";

export const LEO_AGENT_ENV_KEY = "ZCODE_LEO_AGENT";
const LEO_CONFIG_SECTION = "leo";

export interface ResolvedLeoAgentSettings {
  settings: LeoAgentSettings;
  warnings: string[];
}

export function resolveLeoAgentSettings(input: {
  configResult: Pick<ConfigResult, "sources">;
  env: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
}): ResolvedLeoAgentSettings {
  const readFile = input.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const warnings: string[] = [];
  const layers: LeoAgentSettings[] = [];

  const { user, project } = input.configResult.sources;
  const paths = [...(user.loaded ? [user.path] : []), ...(project.loaded ? project.paths : [])];
  for (const path of paths) {
    const section = readLeoSection(path, readFile, warnings);
    if (section === undefined) continue;
    const parsed = parseLeoAgentSettings(section);
    warnings.push(...parsed.warnings.map((warning) => `${path}: ${warning}`));
    layers.push(parsed.settings);
  }

  const envValue = input.env[LEO_AGENT_ENV_KEY]?.trim();
  if (envValue) {
    try {
      const parsed = parseLeoAgentSettings(JSON.parse(envValue));
      warnings.push(...parsed.warnings.map((warning) => `${LEO_AGENT_ENV_KEY}: ${warning}`));
      layers.push(parsed.settings);
    } catch {
      warnings.push(`${LEO_AGENT_ENV_KEY} is not valid JSON; ignored`);
    }
  }

  return { settings: mergeLeoAgentSettings(...layers), warnings };
}

function readLeoSection(
  path: string,
  readFile: (path: string) => string,
  warnings: string[],
): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(path));
  } catch {
    // 文件不可读或不是 JSON：上游配置加载已经给出诊断，这里不重复报。
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const section = (parsed as Record<string, unknown>)[LEO_CONFIG_SECTION];
  if (section !== undefined && (typeof section !== "object" || section === null)) {
    warnings.push(`${path}: "${LEO_CONFIG_SECTION}" must be an object`);
    return undefined;
  }
  return section;
}

/**
 * 把合并后的 Leo 档位以 ZCODE_LEO_AGENT 注入 model adapter 的 env 副本：adapter（prompt_cache_key
 * 开关）与 core 读到的是同一份配置，而不只是进程环境变量那一层。未配置任何档位时原样返回。
 */
export function withLeoAgentEnv(
  env: NodeJS.ProcessEnv | undefined,
  settings: LeoAgentSettings | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!settings || Object.keys(settings).length === 0) return env;
  return { ...(env ?? process.env), [LEO_AGENT_ENV_KEY]: JSON.stringify(settings) };
}
