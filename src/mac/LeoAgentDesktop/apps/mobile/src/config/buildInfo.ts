// 给开发期"我看到的到底是哪一版"提供可读证据。
//
// 关键背景(见 docs/simulator-debugging.md 的 Verification Contract):
// - native 版本号(version/buildNumber)只能证明装的是哪个 dev client 安装包,
//   证明不了当前 JS bundle 是不是你这个分支的最新代码。
// - JS 新鲜度要看「连的是哪个 Metro」——多 worktree 时 8081/8082 很容易连错分支。
// 所以这里把 branch/commit(由 sim:start 经 EXPO_PUBLIC_XDT_GIT_* 注入)和
// Metro host:port(运行时从 Constants.expoConfig.hostUri 取)一起暴露,供 __DEV__ 浮层显示。
//
// branch/commit 走 EXPO_PUBLIC_* 而不是 app.config.js 注入 extra,是有意为之:
// app.config.js 改动会进 @expo/fingerprint → 每个 commit 都变 runtimeVersion、破坏 OTA;
// 而 EXPO_PUBLIC_* 是 JS bundle 层注入,不进 fingerprint(实测验证)。

export interface BuildInfoSources {
  source?: string | null;
  branch?: string | null;
  commit?: string | null;
  version?: string | null;
  buildNumber?: string | null;
  metroHost?: string | null;
}

export interface MobileBuildInfo {
  source: string | null;
  branch: string | null;
  commit: string | null;
  version: string;
  buildNumber: string | null;
  metroHost: string | null;
}

/** 把各路来源(env / Constants)归一成稳定结构;纯函数,便于测试。 */
export function normalizeBuildInfo(sources: BuildInfoSources): MobileBuildInfo {
  return {
    source: cleanStr(sources.source),
    branch: cleanStr(sources.branch),
    commit: cleanStr(sources.commit),
    version: cleanStr(sources.version) ?? '0.0.0',
    buildNumber: cleanStr(sources.buildNumber),
    metroHost: cleanStr(sources.metroHost),
  };
}

/** 紧凑单行标签:`source · v1.0.0 (2026062608) · 127.0.0.1:8082`。 */
export function formatMobileBuildLabel(info: MobileBuildInfo): string {
  const source = info.source ?? info.branch ?? info.commit ?? 'unknown';
  const version = info.buildNumber ? `v${info.version} (${info.buildNumber})` : `v${info.version}`;
  const metro = info.metroHost ? ` · ${info.metroHost}` : '';
  return `${source} · ${version}${metro}`;
}

function cleanStr(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
