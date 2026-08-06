// Bundle src/bin/file-service.ts into a self-contained ESM file deployable to
// remote SSH machines(与 maker-cc-manager/build.mjs 同款管线,含跨平台 EOL
// 归一 plugin 保证 Win/mac 构建 sha256 一致)。产物 dist/file-service.mjs 由
// scripts/build-remote-bundles.mjs 在 dev/prepackage 阶段 stage 给 desktop。

import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';

const normalizeEolPlugin = {
  name: 'normalize-eol-lf',
  setup(build) {
    build.onLoad({ filter: /\.(ts|js|mjs|cjs|json)$/ }, async (args) => {
      const raw = await readFile(args.path, 'utf8');
      const normalized = raw.replace(/\r\n/g, '\n');
      const ext = args.path.slice(args.path.lastIndexOf('.') + 1);
      const loader = ext === 'ts' ? 'ts' : ext === 'json' ? 'json' : 'js';
      return { contents: normalized, loader };
    });
  },
};

await esbuild.build({
  entryPoints: ['src/bin/file-service.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/file-service.mjs',
  banner: { js: '#!/usr/bin/env node' },
  external: [],
  legalComments: 'none',
  minify: false, // keep stack traces readable in remote stderr logs
  sourcemap: false,
  plugins: [normalizeEolPlugin],
});

console.log('built dist/file-service.mjs');
