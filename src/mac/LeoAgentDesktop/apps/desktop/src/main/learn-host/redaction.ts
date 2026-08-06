/**
 * redaction.ts —— learn 证据管道的敏感信息过滤(纯函数,零依赖)。
 *
 * 用在两处:
 *   1. 证据注入前:本地会话检索命中的文本先过滤再进 prompt(隐私第一层)。
 *   2. 产物扫描:蒸馏 session 写出的文件再扫一遍,命中只 warn 不阻断
 *      (第二层;第三层是人工 diff 审查)。
 *
 * 设计取舍:
 *   - 正则永远有假阴性,这里只兜"形态明确"的高置信 pattern;整体隐私保障不靠
 *     单层,靠三层叠加(注入前过滤 → 产物扫描 warn → 人工 diff 审查)+
 *     provenance.personal 标记(当前不拦截发布,供将来发布前泛化流程判定)。
 *   - 宁可保守:变量名里出现 token/secret 字样但值是代码形态的不误杀
 *     (`token = fetchToken()` 不动,`token: "eyJhbG..."` 才动)。
 *   - 幂等:已替换成 [REDACTED:*] 的文本再过一遍不变。
 */

export type RedactionCategory =
  | 'api-key'
  | 'bearer'
  | 'jwt'
  | 'generic-secret'
  | 'home-path'
  | 'internal-address'
  | 'email';

export interface RedactionResult {
  text: string;
  /** 替换发生的总次数。 */
  hitCount: number;
  /** 命中的类别(去重)。 */
  categories: RedactionCategory[];
}

const marker = (category: RedactionCategory): string => `[REDACTED:${category}]`;

/** 值看起来像代码(函数调用 / 属性链 / 模板占位)而非真实密钥 → 不替换。
 *  注意:纯标识符形态(supersecretvalue123)**不**豁免 —— 裸密码就长这样,
 *  宁可误杀代码里的变量引用也不放过真实密钥(隐私优先)。 */
function looksLikeCode(value: string): boolean {
  // 属性链 / 调用: fetchToken() / process.env.FOO / config.get('x') —— 含 . 或 () 才算
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+(?:\([^)]*\))?[,;]?$/.test(value)) return true;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*\([^)]*\)[,;]?$/.test(value)) return true;
  // 模板/环境占位: ${VAR} / {{var}} / <placeholder> / %VAR%
  if (/^(?:\$\{[^}]*\}|\{\{[^}]*\}\}|<[^>]*>|%[^%]+%)[,;]?$/.test(value)) return true;
  // 已经是 redaction 标记
  if (value.startsWith('[REDACTED:')) return true;
  return false;
}

/**
 * 过滤一段文本中的敏感信息。返回替换后的文本、命中次数与类别。
 * 纯函数、无 IO。pattern 应用顺序:具体形态(vendor key / JWT)先于泛化形态
 * (generic key=value),避免泛化规则吃掉具体规则的上下文导致类别失真。
 */
export function redactSensitive(input: string): RedactionResult {
  if (!input) return { text: input, hitCount: 0, categories: [] };
  let text = input;
  let hitCount = 0;
  const categories = new Set<RedactionCategory>();
  const hit = (category: RedactionCategory): void => {
    hitCount += 1;
    categories.add(category);
  };

  // ── vendor API key(形态高度特异,整段替换) ───────────────────────────────
  // OpenAI/Anthropic sk-、GitHub gh[opusr]_、Slack xox[abps]-、AWS AKIA、Google AIza。
  text = text.replace(
    /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[opusr]_[A-Za-z0-9]{20,}|xox[abps]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g,
    () => {
      hit('api-key');
      return marker('api-key');
    },
  );

  // ── Authorization: Bearer <token>(保留 "Bearer " 前缀,只替换令牌) ────────
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g, (_m, prefix: string) => {
    hit('bearer');
    return `${prefix}${marker('bearer')}`;
  });

  // ── JWT 三段式(各段 base64url;eyJ 开头 = base64 的 '{"') ────────────────
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    () => {
      hit('jwt');
      return marker('jwt');
    },
  );

  // ── 通用 secret 赋值:key/token/secret/password = 或 : 后跟 ≥8 字符值 ─────
  // 只替换值、保留 key 名与赋值符;值是代码形态(looksLikeCode)时放行。
  text = text.replace(
    /\b((?:(?:[A-Za-z0-9]+)[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret(?:[_-]?(?:access[_-]?key|key))?|password|passwd|token)(?:[_-][A-Za-z0-9]+)*\s*[:=]\s*)(["']?)([^\s"'<>`]{8,})\2/gi,
    (m, prefix: string, quote: string, value: string) => {
      if (looksLikeCode(value)) return m;
      hit('generic-secret');
      return `${prefix}${quote}${marker('generic-secret')}${quote}`;
    },
  );

  // ── 用户主目录 → ~(三平台形态;保留后续相对路径的可读性) ─────────────────
  // /Users/<name>/x → ~/x;/home/<name> → ~;C:\Users\<name>\x 与 C:/Users/<name>/x
  // → ~。Windows 盘符分支两种分隔符都收(file URL / shell 输出常见正斜杠形态,
  // Codex review)。带空格的 profile 名只吞"至多两个词 + 紧跟分隔符"的形态
  // (C:\Users\John Smith\... 的典型场景)—— 无限贪婪会把路径后的普通句子一并
  // 吃掉("/Users/alice went to /tmp"),两词上限把误吃面压到 prose 里几乎不
  // 存在的"café-style 目录名"场景;更长的名字退化为只脱敏首词(部分保护)。
  text = text.replace(
    /(?:\/(?:Users|home)|[A-Za-z]:[\\/]Users)[\\/](?:[A-Za-z0-9._-]+(?: [A-Za-z0-9._-]+)?(?=[\\/])|[A-Za-z0-9._-]+)/g,
    () => {
      hit('home-path');
      return '~';
    },
  );

  // ── 内网地址(RFC1918 IP、.internal/.corp/.intranet 域名) ─────────────────
  text = text.replace(
    /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.(?:internal|corp|intranet))(?::\d+)?\b/g,
    () => {
      hit('internal-address');
      return marker('internal-address');
    },
  );

  // ── email ─────────────────────────────────────────────────────────────────
  text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, () => {
    hit('email');
    return marker('email');
  });

  return { text, hitCount, categories: [...categories] };
}
