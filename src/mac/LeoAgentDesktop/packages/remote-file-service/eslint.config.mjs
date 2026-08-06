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
                '@cindy/remote-file-service 跑在远端 bundled Node 上,不能依赖 Electron。desktop 侧只消费 ./client 与 ./protocol。',
            },
            {
              group: ['@cindy/maker-remote-ssh', '@cindy/maker-remote-ssh/*'],
              message:
                'daemon 与 SSH 传输解耦:client 只依赖 duck-typed stream handle(见 client.ts 的 FileServiceStream),不 import ssh 包。',
            },
          ],
        },
      ],
    },
  },
);
