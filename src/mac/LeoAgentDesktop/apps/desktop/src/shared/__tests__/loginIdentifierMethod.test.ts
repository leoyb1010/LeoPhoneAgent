import { describe, expect, it } from 'vitest';

import { resolveIdentifierMethod } from '../loginIdentifierMethod';

/**
 * 分区互斥拍板(2026-07-21):cn=手机、global=邮箱;服务端组合永不产生双形态。
 */
describe('resolveIdentifierMethod', () => {
  it('cn:双方式下发也只取手机(双 tab 场景的确定性收敛)', () => {
    expect(resolveIdentifierMethod('cn', { email: true, phone: true })).toBe('phone');
  });

  it('global:双方式下发也只取邮箱', () => {
    expect(resolveIdentifierMethod('global', { email: true, phone: true })).toBe('email');
  });

  it('cn:服务端只发邮箱 → 落到邮箱单形态(缺失兜底,不空屏)', () => {
    expect(resolveIdentifierMethod('cn', { email: true, phone: false })).toBe('email');
  });

  it('global:服务端只发手机 → 落到手机单形态', () => {
    expect(resolveIdentifierMethod('global', { email: false, phone: true })).toBe('phone');
  });

  it('两者都未下发 → 维持区域首选(表单仍可渲染,由服务端校验兜底)', () => {
    expect(resolveIdentifierMethod('cn', { email: false, phone: false })).toBe('phone');
    expect(resolveIdentifierMethod('global', { email: false, phone: false })).toBe('email');
  });
});
