/**
 * Schema version of the on-disk format. Bump when frontmatter / manifest layout changes
 * in a non-backward-compatible way.
 */
export const SCHEMA_VERSION = 1;

export type KnowledgeType = 'module' | 'concern';

export interface KnowledgeFrontmatter {
  id: string;
  type: KnowledgeType;
  covers: string[];
  depends_on?: string[];
  last_synced_commit: string;
  last_synced_at: string;
  stale: boolean;
  stale_reason?: string | null;
  /**
   * When false, `update` skips this knowledge entirely (no rewrite, no stale flip).
   * Defaults to true. Set to false for vendored / read-only modules where business
   * work should never trigger auto-maintenance (e.g. "I wrote this charter once and
   * want it frozen").
   */
  auto_update?: boolean;
  schema_version: number;
}

export interface ManifestEntry {
  id: string;
  path: string;
  type: KnowledgeType;
  covers: string[];
  stale: boolean;
  last_synced_commit: string;
}

export interface Manifest {
  schema_version: number;
  generated_at: string;
  entries: ManifestEntry[];
}

export interface SmallDiffThreshold {
  files: number;
  lines: number;
}

export interface ConfigFile {
  module_roots?: string[];
  ignore?: string[];
  /**
   * Module-level ignore: directory paths (repo-relative, forward-slash) that
   * `discoverModules` should drop from results even if they otherwise match
   * `module_roots` (or the pnpm/npm workspace auto-discovery). Use for paths
   * that ARE valid workspace packages but should not have an agent-maintained
   * knowledge file — e.g. the project-context tool itself (whose .md is so
   * meta that auto-refresh tends to produce wrong-grained content).
   *
   * Different from `ignore` (above) — that one is .gitignore-style and only
   * filters which files trigger `update`; it does not skip module discovery.
   *
   * Matched against the discovered directory path with strict equality
   * (e.g. "packages/project-context"). MVP keeps it simple — no glob support;
   * list each path explicitly if you need to skip several.
   */
  module_ignore?: string[];
  small_diff_threshold: SmallDiffThreshold;
  agent: 'claude-code' | 'codex' | 'custom';
  agent_options?: {
    model?: string;
    /** Per-call timeout for the diff-driven `update` path, in seconds. */
    timeout?: number;
    /**
     * Per-call timeout for the source-exploration `refresh` path, in seconds.
     * Default 600. Refresh can take much longer than update because the agent
     * is reading + summarizing whole packages.
     */
    refreshTimeout?: number;
    command?: string;
  };
}

export interface DiscoveredModule {
  /** Kebab id derived from path, e.g. "packages--maker-core" */
  id: string;
  /** Path relative to repo root, e.g. "packages/maker-core" */
  path: string;
}
