export type RemoteDrawerKind = 'term' | 'files' | 'browser';
export type RemoteDrawerAction = 'copy-cwd' | 'continue' | 'new-on-machine' | 'show-device';

export const REMOTE_DRAWER_ACTION_LABEL: Record<RemoteDrawerAction, string> = {
  'copy-cwd': '复制路径',
  continue: '在同一目录续写',
  'new-on-machine': '在这台机器上新开',
  'show-device': '打开这台设备',
};

export function isRemoteDrawerKind(kind: string | null | undefined): kind is RemoteDrawerKind {
  return kind === 'term' || kind === 'files' || kind === 'browser';
}

/** 中继没有终端/浏览器代理。文件抽屉能读会话产物正文,打不开整棵远程磁盘。 */
export function remoteDrawerCopy(kind: RemoteDrawerKind, ctx: { machineName: string; cwd?: string | null }): {
  title: string;
  lead: string;
  body: string;
} {
  const cwd = ctx.cwd?.trim() ?? '';
  const where = cwd ? `${ctx.machineName} 的 ${cwd}` : ctx.machineName;
  if (kind === 'term') {
    return {
      title: '远程 · 终端',
      lead: '本机抽屉接不到那台机器的 shell。',
      body: `会话在 ${where}。复制路径,或直接在那台机器上续写 / 新开。`,
    };
  }
  if (kind === 'files') {
    return {
      title: '远程 · 文件',
      lead: '整棵远程磁盘打不开，改过的文件可以从中继读正文。',
      body: `会话在 ${where}。点下面的文件看内容;要看整棵树,到那台机器上开。`,
    };
  }
  return {
    title: '远程 · 浏览器',
    lead: '本机浏览器接不到那台机器的屏幕。',
    body: `会话在 ${where}。复制路径,或在那台机器上继续。`,
  };
}

export function remoteDrawerActions(ctx: { cwd?: string | null }): RemoteDrawerAction[] {
  const actions: RemoteDrawerAction[] = [];
  if (ctx.cwd?.trim()) actions.push('copy-cwd');
  actions.push('continue', 'new-on-machine', 'show-device');
  return actions;
}

export function remoteFileSubstitute(edits: ReadonlyArray<{ key: string; file: string; running?: boolean; error?: boolean }>): Array<{ key: string; file: string; state: string }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; file: string; state: string }> = [];
  for (const row of edits) {
    const file = row.file.trim();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push({
      key: row.key,
      file,
      state: row.running ? '进行中' : row.error ? '失败' : '已改',
    });
  }
  return out;
}

/** 工具行上的文件 + 产物清单,去重后给抽屉钉住。 */
export function mergeFilePins(
  edits: ReadonlyArray<{ key: string; file: string; running?: boolean; error?: boolean }>,
  artifacts: ReadonlyArray<{ name: string }>,
): Array<{ key: string; file: string; state: string }> {
  const out = remoteFileSubstitute(edits);
  const seen = new Set(out.map((row) => row.file));
  for (const row of artifacts) {
    const file = row.name.trim();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push({ key: `art:${file}`, file, state: '产物' });
  }
  return out;
}
