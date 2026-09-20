export function isPeekDrawer(kind: string | null | undefined): boolean {
  return kind === 'files' || kind === 'diff';
}

export function isWorkspaceDrawer(kind: string | null | undefined): boolean {
  return kind === 'files' || kind === 'diff' || kind === 'term';
}

/** 会话 cwd + 工具行上的相对路径 → 文件树/读文件用的绝对路径。 */
export function sessionFilePath(cwd: string, file: string): string {
  const root = cwd.trim().replace(/[\\/]+$/, '');
  const rel = file.trim();
  if (!rel) return '';
  if (rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel)) return rel;
  if (!root) return rel;
  return `${root}/${rel.replace(/^[\\/]+/, '')}`;
}

export function clipFilePeek(text: string, limit = 80_000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…(后面还有 ${text.length - limit} 字)`;
}

export function isClippedFilePeek(text: string | null | undefined): boolean {
  return /\n…\(后面还有 \d+ 字\)$/.test(text ?? '');
}

/** 只有本机项目里读完整正文的预览才能写回,截断/报错/远程产物都不动。 */
export function peekCanWriteBack(input: {
  machine?: string | null;
  projectId?: string | null;
  path?: string | null;
  peek?: string | null;
}): boolean {
  if (input.machine !== 'local') return false;
  if (!input.projectId?.trim() || !input.path?.trim()) return false;
  const peek = input.peek ?? '';
  if (!peek || peek === '正在读…' || peek.startsWith('读不了:')) return false;
  return !isClippedFilePeek(peek);
}

/** 绝对路径或相对路径 → 产物清单用的 cwd 相对名。 */
/** 预览上头只写文件名,不要整段绝对路径占一行。 */
export function peekFileCaption(file: string | null | undefined): string {
  const raw = (file ?? '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  return raw.split('/').pop() || raw;
}

/** 顶栏目录芯片只留最后一段,完整路径放 title。 */
export function cwdChipLabel(cwd: string | null | undefined): string {
  return peekFileCaption((cwd ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, ''));
}

/** 给人看的机器名去掉 .local,完整名放 title。 */
export function machineChipLabel(name: string | null | undefined): string {
  return (name ?? '').trim().replace(/\.local$/i, '');
}

/** 窗口顶条只写主控+机器+目录,长会话标题留给 shead 去点。 */
export function titlebarHomeCopy(input: { hasSession: boolean; machineName?: string | null; cwd?: string | null }): { title: string; sub: string } {
  if (!input.hasSession) return { title: '主控', sub: '' };
  const sub = [machineChipLabel(input.machineName), cwdChipLabel(input.cwd)].filter(Boolean).join(' · ');
  return { title: '主控', sub };
}

export function artifactNameFromPath(cwd: string, file: string): string {
  const rel = file.trim();
  if (!rel) return '';
  const root = cwd.trim().replace(/[\\/]+$/, '');
  if (root && (rel === root || rel.startsWith(`${root}/`))) return rel.slice(root.length).replace(/^[\\/]+/, '');
  return rel.replace(/^\.\//, '');
}
