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
              message: '@cindy/voice-input-core 不能依赖 Electron。麦克风、IPC、凭证、日志由 host 注入。',
            },
            {
              group: ['ws', 'ws/*'],
              message: '@cindy/voice-input-core 不能绑定具体 websocket 实现。Provider 适配放在 host 层。',
            },
          ],
        },
      ],
    },
  },
);
