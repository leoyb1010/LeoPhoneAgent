import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import micromatch from 'micromatch';
import { SCHEMA_VERSION, type Manifest, type ManifestEntry } from './types.js';
import { readKnowledgeFile } from './knowledge.js';
import { CONCERNS_SUBDIR, MODULES_SUBDIR, type ResolvedPaths } from './config.js';

export function readManifest(manifestPath: string): Manifest {
  if (!fs.existsSync(manifestPath)) {
    return { schema_version: SCHEMA_VERSION, generated_at: new Date().toISOString(), entries: [] };
  }
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const parsed = (yaml.load(raw) ?? {}) as Partial<Manifest>;
  return {
    schema_version: parsed.schema_version ?? SCHEMA_VERSION,
    generated_at: parsed.generated_at ?? new Date().toISOString(),
    entries: parsed.entries ?? [],
  };
}

export function writeManifest(manifestPath: string, entries: ManifestEntry[]): void {
  const sorted = entries.sort((a, b) => a.id.localeCompare(b.id));

  // Preserve generated_at when entries haven't changed to avoid metadata-only diffs.
  let generatedAt = new Date().toISOString();
  if (fs.existsSync(manifestPath)) {
    const old = readManifest(manifestPath);
    const entriesEqual =
      old.entries.length === sorted.length &&
      old.entries.every(
        (o, i) =>
          o.id === sorted[i]!.id &&
          o.stale === sorted[i]!.stale &&
          o.last_synced_commit === sorted[i]!.last_synced_commit,
      );
    if (entriesEqual) generatedAt = old.generated_at;
  }

  const manifest: Manifest = {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    entries: sorted,
  };
  const yamlText = yaml.dump(manifest, { lineWidth: 200, noRefs: true });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, yamlText, 'utf8');
}

/**
 * Rebuild manifest by scanning all knowledge files in modules/ and concerns/.
 * Used after init / update to keep manifest in sync with on-disk truth.
 */
export function rebuildManifestFromDisk(paths: ResolvedPaths): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const [subdir, type] of [
    [paths.modulesDir, 'module'] as const,
    [paths.concernsDir, 'concern'] as const,
  ]) {
    if (!fs.existsSync(subdir)) continue;
    const files = fs.readdirSync(subdir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(subdir, file);
      const knowledge = readKnowledgeFile(filePath);
      const relPath = path.posix.join(
        type === 'module' ? MODULES_SUBDIR : CONCERNS_SUBDIR,
        file,
      );
      entries.push({
        id: knowledge.frontmatter.id,
        path: relPath,
        type: knowledge.frontmatter.type,
        covers: knowledge.frontmatter.covers,
        stale: knowledge.frontmatter.stale,
        last_synced_commit: knowledge.frontmatter.last_synced_commit,
      });
    }
  }
  return entries;
}

/**
 * Return the IDs of knowledge entries whose `covers` glob matches the given file path.
 * `relFile` should be repo-root-relative with forward slashes.
 */
export function findKnowledgeIdsForFile(relFile: string, manifest: Manifest): string[] {
  const normalized = relFile.replace(/\\/g, '/');
  const matched: string[] = [];
  for (const entry of manifest.entries) {
    if (micromatch.isMatch(normalized, entry.covers, { dot: true })) {
      matched.push(entry.id);
    }
  }
  return matched;
}

export function findEntryById(manifest: Manifest, id: string): ManifestEntry | undefined {
  return manifest.entries.find((e) => e.id === id);
}
