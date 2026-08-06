import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/'],
  },
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*', 'electron-*'],
              message:
                '@cindy/file-browser-core 不能依赖 Electron——它同时跑在 desktop main 和远端 file-service daemon 里。窗口、IPC、日志由 host 注入。',
            },
            {
              group: ['@parcel/watcher', '@parcel/watcher/*'],
              message:
                '@cindy/file-browser-core 不能绑定原生 watcher 实现(prebuilt 二进制无法进 daemon bundle)。watch 由各 host 各自实现,共享 FileTreeEvent 事件形状即可。',
            },
          ],
        },
      ],
    },
  },
);
