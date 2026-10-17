// [fix-remote] 外部 agent（ACP）回合失败时给人看的错误：哪个 agent、什么原因、在 Mac 上怎么修，
// 再附上 agent stderr 的最后几行（去掉密钥一类的敏感信息）。
// 运行时会把错误 message 压成一行、截到 500 字（core/errors/error-payload.ts），手机的 run.failed 只拿到
// 这一行，所以修法与 stderr 摘要都放进 message 本身，完整的多行 stderr 另放 detail。
import { homedir } from "node:os";
import { acpAgentInfo, type AcpAgentId } from "@zcode/shared/acp";

export type AcpFailureKind = "unavailable" | "auth" | "spawn" | "exited" | "other";

export class AcpAgentError extends Error {
  readonly agentId: AcpAgentId;
  readonly kind: AcpFailureKind;
  /** 多行的 agent stderr 尾部（已脱敏）。 */
  readonly detail?: string;
  /** 登录、安装这类问题重试也没用：不让运行时自动重试。 */
  readonly retryable = false;

  constructor(agentId: AcpAgentId, kind: AcpFailureKind, message: string, options: { detail?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AcpAgentError";
    this.agentId = agentId;
    this.kind = kind;
    if (options.detail) this.detail = options.detail;
  }
}

const LOGIN_HINTS: Record<AcpAgentId, string> = {
  "claude-code":
    "在这台 Mac 的终端运行 claude 并 /login（或在 LeoBot 设置 → 外部 agent → Claude Code 粘贴 claude setup-token 生成的长期令牌）",
  codex: "在这台 Mac 的终端运行 codex login",
  gemini: "在这台 Mac 的终端运行 gemini 完成登录（或配置 GEMINI_API_KEY）",
  opencode: "在这台 Mac 的终端运行 opencode auth login",
  grok: "在这台 Mac 的终端运行 grok login",
};

const INSTALL_HINTS: Record<AcpAgentId, string> = {
  "claude-code": "在这台 Mac 上安装 Claude Code（curl -fsSL https://claude.ai/install.sh | bash）",
  codex: "在这台 Mac 上安装 Codex CLI（npm i -g @openai/codex）",
  gemini: "在这台 Mac 上安装 Gemini CLI（npm i -g @google/gemini-cli）",
  opencode: "在这台 Mac 上安装 opencode（curl -fsSL https://opencode.ai/install | bash）",
  grok: "在这台 Mac 上安装 Grok Build 并 grok login",
};

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk|pk|rk|xai|ghp|gho|ghs|glpat|AIza)[-_A-Za-z0-9]{8,}/g, "[已隐藏]"],
  [/\bBearer\s+[^\s"']+/gi, "Bearer [已隐藏]"],
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
    "$1$2[已隐藏]",
  ],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[已隐藏]"],
  [/\b[A-Fa-f0-9]{40,}\b/g, "[已隐藏]"],
  [/[A-Za-z0-9+/]{48,}={0,2}/g, "[已隐藏]"],
];

/** 去掉 stderr 里可能出现的密钥、令牌，并把主目录换成 ~。 */
export function redactAgentOutput(text: string, home: string = homedir()): string {
  let out = text;
  // eslint-disable-next-line no-control-regex -- 去掉终端颜色控制符
  out = out.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  if (home && home.length > 1) out = out.split(home).join("~");
  return out;
}

/** 维护 stderr 最后若干行（逐块追加）。 */
export function appendStderrTail(tail: string[], chunk: string, limit = 20): void {
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) tail.push(trimmed.slice(0, 400));
  }
  if (tail.length > limit) tail.splice(0, tail.length - limit);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
}

const AUTH_PATTERN =
  /auth(entication)?[ _-]?required|not (logged|signed) in|please (log|sign) ?in|unauthori[sz]ed|\b401\b|invalid api key|login required|credentials? (not found|missing|expired)|未登录/i;

function classify(error: unknown, stderr: string): AcpFailureKind {
  const message = errorMessage(error);
  const code = errorCode(error);
  // ACP 的 auth_required 是 JSON-RPC -32000（SDK RequestError.authRequired）。
  if (code === -32000 || AUTH_PATTERN.test(message)) return "auth";
  if (code === "ENOENT" || code === "EACCES" || /spawn .*(ENOENT|EACCES)/.test(message)) return "spawn";
  if (/ACP agent 已退出|connection closed|stream closed|EPIPE/i.test(message)) {
    return AUTH_PATTERN.test(stderr) ? "auth" : "exited";
  }
  return "other";
}

/** 把任意失败包成给人看的 AcpAgentError（已经包过的原样返回）。 */
export function describeAcpFailure(input: {
  agentId: AcpAgentId;
  error: unknown;
  stderrTail?: readonly string[];
  home?: string;
}): AcpAgentError {
  if (input.error instanceof AcpAgentError) return input.error;
  const name = acpAgentInfo(input.agentId).name;
  const lines = (input.stderrTail ?? []).map((line) => redactAgentOutput(line, input.home));
  const stderr = lines.join("\n");
  const raw = redactAgentOutput(errorMessage(input.error), input.home).replace(/\s+/g, " ").trim();
  const kind = classify(input.error, stderr);
  let summary: string;
  switch (kind) {
    case "auth":
      summary = `${name} 在这台 Mac 上未登录或读不到登录态：${LOGIN_HINTS[input.agentId]}，再回来重试`;
      break;
    case "spawn":
      summary = `${name} 在这台 Mac 上启动不了（找不到或无法执行命令）：${INSTALL_HINTS[input.agentId]}`;
      break;
    case "exited": {
      const exit = /code=(\S+?) signal=(\S+?)）/.exec(raw);
      const how = !exit ? "连接断开" : exit[2] !== "null" ? `信号 ${exit[2]}` : `退出码 ${exit[1]}`;
      summary = `${name} 进程意外退出（${how}）：在这台 Mac 的终端直接运行它看看能否正常启动`;
      break;
    }
    default:
      summary = `${name} 出错：${raw.slice(0, 200) || "未知错误"}`;
  }
  const tail = lines.slice(-3).join(" | ");
  const message = tail ? `${summary}。agent 最后输出：${tail}`.slice(0, 480) : summary.slice(0, 480);
  return new AcpAgentError(input.agentId, kind, message, {
    ...(stderr ? { detail: stderr } : {}),
    cause: input.error,
  });
}

/** 本机没装 / 适配器缺失：启动前就知道失败。 */
export function acpUnavailableError(agentId: AcpAgentId, reason: string | undefined): AcpAgentError {
  const name = acpAgentInfo(agentId).name;
  return new AcpAgentError(
    agentId,
    "unavailable",
    `${name} 在这台 Mac 上不可用：${reason ?? "无法启动"}。${INSTALL_HINTS[agentId]}`,
  );
}
