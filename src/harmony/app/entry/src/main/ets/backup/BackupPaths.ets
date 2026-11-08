import { fileIo } from '@kit.CoreFileKit';
import { backupMkdir } from './BackupFiles';

export const BACKUP_ROOT_FILES: string[] = ['providers.json', 'mcp.json', 'mcp-oauth.json', 'env.json', 'skills.json', 'SOUL.md',
  'collections.json', 'schedule.json', 'body.json', 'usage.json', 'sync-config-ids.json', 'chat-drafts.json',
  'sync-file-index.json', 'sync-artifact-heads.json', 'sync-collection-session.json', 'sync-disabled-destinations.json'];
export const BACKUP_TREE_DIRS: string[] = ['sessions', 'chat-images', 'workspace', 'memory', 'schedule-claims', 'recordings', 'skill-bundles'];
export function backupSafeTreePath(path: string): boolean {
  if (typeof path !== 'string' || !path || path.length > 1024 || /[\\\u0000-\u001f\u007f]/.test(path)) { return false; }
  const parts = path.split('/');
  if (parts.length > 32 || parts.some((part: string) => !part || part === '.' || part === '..' || part.endsWith('.lock') || part.endsWith('.tmp'))) { return false; }
  return parts.length === 1 ? BACKUP_ROOT_FILES.includes(path) : BACKUP_TREE_DIRS.includes(parts[0]);
}
export function backupTarget(root: string, path: string, createParents: boolean = true): string {
  if (!backupSafeTreePath(path)) { throw new Error('备份恢复路径不安全'); }
  const parts = path.split('/'); let parent = root;
  for (let index = 0; index < parts.length - 1; index++) {
    parent += '/' + parts[index];
    if (createParents) { backupMkdir(parent); }
    else if (!fileIo.accessSync(parent)) { return root + '/' + path; }
    const stat = fileIo.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('备份路径祖先含不安全链接'); }
  }
  const target = root + '/' + path;
  if (fileIo.accessSync(target)) {
    const stat = fileIo.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) { throw new Error('备份恢复目标不安全'); }
  }
  return target;
}
export class BackupFileRecord {
  path: string = '';
  size: number = 0;
  sha256: string = '';
  existed: boolean = true;
}
export function backupParseRecord(line: string): BackupFileRecord {
  const row = JSON.parse(line) as BackupFileRecord;
  if (!row || !backupSafeTreePath(row.path) || !Number.isSafeInteger(row.size) || row.size < 0 ||
    typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256) || typeof row.existed !== 'boolean') { throw new Error('备份文件索引无效'); }
  return row;
}
