/**
 * env live binding 顶层捕获守门(静态断言,desktop endpointEnvUsageGuard 同款思路)。
 *
 * env.ts 的三个运行期端点是 `export let` live binding:启动闸门拉到远程端点清单后
 * 重赋值,消费点必须**调用时读取**。任何模块顶层 `const X = <binding>` 派生都会在
 * bundle 求值期拷贝烘焙值、永远吃不到远程覆写——不报错、typecheck 拦不住,只有改
 * OSS 清单时才暴露(P1 实例:mobileVoiceLiteLlmSettings 曾顶层拷贝当时还是 live
 * binding 的 MOBILE_VOICE_LITELLM_BASE_URL;该值已随清单 xdGatewayBaseUrl 退役
 * 改为构建期常量,不再入列)。
 *
 * 启发式:凡 import 了这些 binding 的源码文件,顶层(非缩进)const 声明行不得引用
 * binding 名。需要顶层派生时改成惰性函数(参考 mobileVoiceLiteLlmDefaultProxyBaseUrl)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// expo-router 路由文件同样是 env 消费者,一并纳入扫描
const APP_ROOT = path.resolve(SRC_ROOT, '..', 'app');

const LIVE_BINDINGS = [
  'AUTH_API_BASE_URL',
  'OAUTH_BROKER_API_BASE_URL',
  'DEVICE_LINK_API_BASE_URL',
];

// 顶层 const 声明行(无缩进),初始化器引用了任一 live binding(词边界,排除
// DEFAULT_DEVICE_LINK_API_BASE_URL 这类更长标识符的子串误报由 \b + 前缀负向断言保证)。
const TOP_LEVEL_CAPTURE = new RegExp(
  `^(?:export )?const [^=\\n]+=[^\\n]*(?<![A-Za-z0-9_$])(?:${LIVE_BINDINGS.join('|')})\\b`,
  'm',
);

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === '__tests__') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkSourceFiles(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) yield full;
  }
}

describe('env live binding 不允许被模块顶层 const 捕获', () => {
  it('src 下无顶层捕获', () => {
    const envFile = path.join(SRC_ROOT, 'config', 'env.ts');
    const violations: string[] = [];
    const files = [...walkSourceFiles(SRC_ROOT), ...walkSourceFiles(APP_ROOT)];
    for (const file of files) {
      if (file === envFile) continue; // 定义处自身豁免
      const content = fs.readFileSync(file, 'utf8');
      if (!content.includes("from '@/config/env'") && !content.includes('from "@/config/env"')) {
        continue;
      }
      if (TOP_LEVEL_CAPTURE.test(content)) {
        violations.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(
      violations,
      `以下文件在模块顶层 const 捕获了 env live binding(改成惰性函数,调用时读取):\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
