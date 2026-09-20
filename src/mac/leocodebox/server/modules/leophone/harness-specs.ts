import fs from 'node:fs';
import path from 'node:path';

import * as piRuntime from './pi-runtime.js';

// LeoPhoneAgent harness 协议的 CLI 规格表——与 leoagent(Python) 的 HARNESSES
// 逐项对齐:同样的 argv、同样的方言。手机端按 key 选择,服务端只申报本机
// 真实可启动的条目。

export type HarnessDialectKind = 'claude_stream_json' | 'codex_app_server' | 'pi_rpc' | 'grok_acp';

export interface HarnessModel { provider: string; modelId: string }

/** 启动一条会话时交给 spec 钩子的上下文。 */
export interface HarnessLaunchContext {
  sessionId: string;
  cwd: string;
  home: string;
  model: HarnessModel | null;
  policy: string;
  /** 续聊时指向已有的 pi 会话文件;没有就按 sessionId 新建。 */
  resumeSession?: string;
}

export interface HarnessSpec {
  key: string;
  displayName: string;
  executable: string;
  args: string[];
  dialect: HarnessDialectKind;
  /** 桌面启动器为该 CLI 解析出的绝对路径所在的环境变量(存在则优先)。 */
  pathEnvVar?: string;
  /** Leoapi 供应商切换的目标名;有值的 CLI 启动时套用 applyActiveSwitchEnv。 */
  switchTarget?: 'claude' | 'codex';
  /** One-shot CLIs such as Cursor receive the first prompt as an argv value. */
  promptInArgs?: boolean;
  /** 应用自带运行时:不查 PATH,自己给出可执行路径(null = 本构建里没有)。 */
  resolve?: () => string | null;
  /** 按会话构造 argv;有它就不用 args 模板。 */
  buildArgs?: (ctx: HarnessLaunchContext) => string[];
  /** 按会话补子进程环境。 */
  buildEnv?: (env: Record<string, string | undefined>, ctx: HarnessLaunchContext) => Record<string, string | undefined>;
  /** 启动前的落盘准备(策略文件、extension 等)。 */
  prepare?: (ctx: HarnessLaunchContext) => Promise<void> | void;
  /** 是否接受 model / policy 参数(2.0 内核)。 */
  selectsModel?: boolean;
}

export const HARNESSES: Record<string, HarnessSpec> = {
  claude: {
    key: 'claude',
    displayName: 'Claude Code',
    executable: 'claude',
    args: [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      // 没有它,print 模式自动拒绝一切需要权限的工具,control_request 永远
      // 不会到达——审批流根本不会触发。'stdio' 把 can_use_tool 走控制协议。
      '--permission-prompt-tool', 'stdio',
    ],
    dialect: 'claude_stream_json',
    pathEnvVar: 'CLAUDE_CLI_PATH',
    switchTarget: 'claude',
  },
  codex: {
    key: 'codex',
    displayName: 'Codex CLI',
    executable: 'codex',
    // 0.14x 起 `codex proto` 要求 TTY,管道模式走 app-server(JSON-RPC over stdio)。
    args: ['app-server'],
    dialect: 'codex_app_server',
    pathEnvVar: 'CODEX_CLI_PATH',
    switchTarget: 'codex',
  },
  pi: {
    key: 'pi',
    displayName: 'pi',
    // 2.0 内核:不是外装的 pi CLI,而是打进应用的 rpc-entry,用宿主 Node 跑。
    executable: 'pi',
    args: ['--mode', 'rpc'],
    dialect: 'pi_rpc',
    selectsModel: true,
    resolve: () => piRuntime.resolveCommand()?.command ?? null,
    buildArgs: (ctx) => piRuntime.buildArgs(ctx),
    buildEnv: (env, ctx) => piRuntime.buildEnv(env, ctx),
    prepare: (ctx) => piRuntime.prepare(ctx),
  },
  grok: {
    key: 'grok',
    displayName: 'Grok CLI',
    executable: 'grok',
    // 裸 `grok` 是 TUI;无头走 ACP over stdio(Agent Client Protocol)。
    args: ['agent', 'stdio'],
    dialect: 'grok_acp',
  },
  cursor: {
    key: 'cursor',
    displayName: 'Cursor Agent',
    executable: 'cursor-agent',
    // Cursor's supported headless contract is one-shot stream-json. `spawn`
    // receives an argv array, so even multiline prompts never pass through a shell.
    args: ['-p', '{prompt}', '--output-format', 'stream-json'],
    dialect: 'claude_stream_json',
    promptInArgs: true,
  },
};

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * 解析一个 harness 的可执行路径:专用环境变量优先(桌面启动器已把设备上
 * 真实的 CLI 路径写进去),否则按 PATH 查找。找不到返回 null——服务端绝不
 * 提供一个启动即失败的选项。
 */
export function resolveExecutable(spec: HarnessSpec): string | null {
  if (spec.resolve) return spec.resolve();
  if (spec.pathEnvVar) {
    const pinned = (process.env[spec.pathEnvVar] || '').trim();
    if (pinned && isExecutableFile(pinned)) return pinned;
  }
  const pathValue = process.env.PATH || '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, spec.executable);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** 本机真实可跑的 harness 列表,供手机端选择器展示。 */
export function availableHarnesses(): Array<{ key: string; name: string; executable: string }> {
  return Object.values(HARNESSES)
    .filter((spec) => resolveExecutable(spec) !== null)
    .map((spec) => ({ key: spec.key, name: spec.displayName, executable: spec.executable }));
}
