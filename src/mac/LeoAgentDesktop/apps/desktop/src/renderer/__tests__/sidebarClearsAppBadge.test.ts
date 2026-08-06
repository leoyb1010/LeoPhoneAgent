import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sidebarSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
);

describe('sidebar clears system app badge', () => {
  it('clears task-completion app badge when a session is opened', () => {
    // 统一走 clearSystemSessionAttention 咽喉:本机 IPC 恒发,device-link 远程会话
    // 再补隧道回执把被控端未读一并清掉(见 sessionAttentionStore)。
    expect(sidebarSource).toContain('clearSystemSessionAttention(viewedSessionId)');
    expect(sidebarSource).toContain('clearSystemSessionAttention(id)');
    // 不允许退回绕过咽喉的裸 IPC 调用(那会丢远程回执路由)。
    expect(sidebarSource).not.toContain('notificationClearSessionAttention(');
  });
});
