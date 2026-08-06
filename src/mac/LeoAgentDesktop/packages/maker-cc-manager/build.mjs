// Bundle src/bin/cc-mgr.ts into a self-contained ESM file deployable to remote
// SSH machines. Uses esbuild programmatically to avoid CLI shell-quote issues
// (the --banner:js='#!/...' form breaks on Windows PowerShell and some shells).

import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';

// Cross-platform deterministic bundle plugin: force every source file fed into
// esbuild to use LF line endings. Without this, Windows checkouts (git
// autocrlf=true → CRLF) and POSIX checkouts (LF) produce bundles with
// different sha256 — string-literal contents (including comments and template
// strings) preserve whatever EOL the source had. Empirically verified: same
// source, Windows build vs mac build, hash differs end-to-end. This plugin
// makes the bundle byte-identical regardless of host OS or git config.
const normalizeEolPlugin = {
  name: 'normalize-eol-lf',
  setup(build) {
    build.onLoad({ filter: /\.(ts|js|mjs|cjs|json)$/ }, async (args) => {
      const raw = await readFile(args.path, 'utf8');
      const normalized = raw.replace(/\r\n/g, '\n');
      // Pick loader by extension; mirror esbuild's defaults so we don't
      // accidentally drop tsx / jsx support (none of our bundles use those
      // today but the plugin should be safe to keep around).
      const ext = args.path.slice(args.path.lastIndexOf('.') + 1);
      const loader =
        ext === 'ts'
          ? 'ts'
          : ext === 'json'
            ? 'json'
            : 'js'; // .js .mjs .cjs all parsed as JS
      return { contents: normalized, loader };
    });
  },
};

await esbuild.build({
  entryPoints: ['src/bin/cc-mgr.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/cc-mgr.mjs',
  banner: { js: '#!/usr/bin/env node' },
  // SDK ships pre-bundled — we just include it as-is.
  external: [],
  legalComments: 'none',
  minify: false, // keep stack traces readable in production logs
  sourcemap: false,
  plugins: [normalizeEolPlugin],
});

console.log('built dist/cc-mgr.mjs');
