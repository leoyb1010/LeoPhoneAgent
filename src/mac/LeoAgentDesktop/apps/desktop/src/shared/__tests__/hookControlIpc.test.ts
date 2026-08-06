/**
 * slackHookInstallUrl: WS 地址 → Slack App 安装链接的纯函数推导。
 * 受控域名不写字面量(check-endpoint-literals):协议转换语义用中性域名断言。
 * 内置默认地址不再是烘焙常量(2026-07 起来自运行期端点清单),推导语义与
 * 中性域名用例同构,无需单独用例。
 */
import { describe, expect, it } from 'vitest';

import { slackHookInstallUrl } from '../hookControlIpc';

describe('slackHookInstallUrl', () => {
  it('wss 转 https 并拼 /slack/install', () => {
    expect(slackHookInstallUrl('wss://example.com')).toBe('https://example.com/slack/install');
  });

  it('ws 转 http(本地自部署调试)', () => {
    expect(slackHookInstallUrl('ws://localhost:8787')).toBe('http://localhost:8787/slack/install');
  });

  it('尾斜杠不产生双斜杠', () => {
    expect(slackHookInstallUrl('wss://example.com/')).toBe('https://example.com/slack/install');
  });

  it('意外 query/hash 不被吞(结果直接交 openExternal)', () => {
    expect(slackHookInstallUrl('wss://hook.example.com')).toBe(
      'https://hook.example.com/slack/install',
    );
  });
});
