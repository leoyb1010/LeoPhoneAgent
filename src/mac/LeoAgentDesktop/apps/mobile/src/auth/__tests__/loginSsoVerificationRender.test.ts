import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * renderSsoVerification 错误可见性回归(SC-SOC + P1-1):
 * mobile 无 component render 框架,沿用仓内「读源码断言」模式验证结构不变量。
 * 不变量:errorNode 必须在 `!state.codeRequested` 条件【之外】,两个子态都渲染——
 * 否则首次「发送验证码」失败(codeRequested 仍 false)时错误不显示(silent failure,
 * desktop 是常显的,双端须一致)。
 */
vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'zh-CN' }],
}));

const loginSource = readFileSync(
  resolve(process.cwd(), 'app/(auth)/login.tsx'),
  'utf8',
);

describe('renderSsoVerification 错误可见性(P1-1:两子态都渲染错误)', () => {
  const blockStart = loginSource.indexOf('const renderSsoVerification');
  const block = loginSource.slice(
    blockStart,
    loginSource.indexOf('const renderBinding', blockStart),
  );

  it('renderSsoVerification 存在且含 errorNode', () => {
    expect(blockStart, 'renderSsoVerification exists').toBeGreaterThan(-1);
    expect(block, 'block non-empty').toBeTruthy();
    expect(block.indexOf('{errorNode}'), 'has errorNode').toBeGreaterThan(-1);
  });

  it('errorNode 在 !state.codeRequested 条件之外(首次发码失败 codeRequested=false 时错误仍可见,非 silent failure)', () => {
    // codeRequested=true 子态结尾 </> 之后的条件 ternary 结尾 )},errorNode 必须在其后(条件外)
    const substateClose = block.lastIndexOf('</>');
    expect(substateClose, 'codeRequested=true substate closes </>').toBeGreaterThan(-1);
    const condClose = block.indexOf(')}', substateClose);
    expect(condClose, 'ternary condition closes )}').toBeGreaterThan(-1);
    const errorIdx = block.indexOf('{errorNode}', condClose);
    expect(
      errorIdx,
      'errorNode rendered OUTSIDE !codeRequested condition (visible in both substates)',
    ).toBeGreaterThan(-1);
  });

  it('验证码已发子态(codeRequested=true)仍渲染错误(errorNode 在 LoginPanel 内、条件外)', () => {
    const errorIdx = block.indexOf('{errorNode}');
    const panelClose = block.indexOf('</LoginPanel>');
    expect(errorIdx, 'errorNode present').toBeGreaterThan(-1);
    expect(panelClose, 'LoginPanel closes').toBeGreaterThan(-1);
    expect(errorIdx, 'errorNode before LoginPanel close (stays in panel)').toBeLessThan(
      panelClose,
    );
  });
});
