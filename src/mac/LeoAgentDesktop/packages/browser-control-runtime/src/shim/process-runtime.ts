// Shim: openclaw/plugin-sdk/process-runtime → ported self-contained OOM-score
// helper (Linux-only behavior; no-op wrap on mac/win). No logger/config graph.
export {
  prepareOomScoreAdjustedSpawn,
  type OomScoreAdjustedSpawn,
  type OomWrapOptions,
} from './_local/oom-score.js';
