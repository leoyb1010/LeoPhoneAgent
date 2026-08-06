/**
 * reconcileMineRegistry.ts — one-time repair for local registry ownership.
 *
 * This path reconciles ownership metadata from the server. It intentionally
 * does not update an existing install's version: version is coupled to the
 * local folder contents and folderHash, so silently copying server latestVersion
 * would hide the "another device published a newer version" state.
 */
import { computeFolderHash } from './folderHash';
import { createLogger } from '../logger';
import { registryService } from './registry';

const log = createLogger('skillhubReconcileMineRegistry');

export interface ReconcileMineRegistryItem {
  name: string;
  absolutePath: string;
  version: string;
  authorId: string;
  folderHash?: string;
}

export interface ReconcileMineRegistryResult {
  success: true;
  added: number;
  flipped: number;
  failures: Array<{ name: string; error: string }>;
}

export async function reconcileMineRegistry(
  items: ReconcileMineRegistryItem[],
): Promise<ReconcileMineRegistryResult> {
  let added = 0;
  let flipped = 0;
  const failures: Array<{ name: string; error: string }> = [];

  for (const item of items) {
    try {
      const existing = await registryService.getInstall(item.name, item.absolutePath);
      if (existing) {
        const needsAuthorId = existing.authorId !== item.authorId && item.authorId !== '';
        const needsOrigin = !existing.origin; // Only fill missing origin; don't turn installed into published.
        if (!needsAuthorId && !needsOrigin) continue;
        await registryService.updateInstall(item.name, item.absolutePath, {
          ...(needsAuthorId ? { authorId: item.authorId } : {}),
          ...(needsOrigin ? { origin: 'published' as const } : {}),
          updatedAt: Math.floor(Date.now() / 1000),
        });
        flipped++;
        continue;
      }

      // Completely missing record: legacy hand-written published skill. Use
      // server latestVersion to create the initial registry baseline. When
      // server folderHash is available, keep it as the baseline so a stale or
      // locally edited folder does not get silently marked clean.
      if (!item.version) continue;
      const folderHash = item.folderHash
        ?? (await computeFolderHash(item.absolutePath).catch(() => null))
        ?? '';
      const nowSec = Math.floor(Date.now() / 1000);
      await registryService.addInstall(item.name, item.absolutePath, {
        version: item.version,
        authorId: item.authorId,
        folderHash,
        installedAt: nowSec,
        updatedAt: nowSec,
        origin: 'published',
      });
      added++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('[skillhub:reconcile-mine-registry] item failed:', item.name, err);
      failures.push({ name: item.name, error: message });
    }
  }

  return { success: true, added, flipped, failures };
}
