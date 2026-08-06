import { describe, expect, it } from 'vitest';

import { resolveIdentifierMethod } from '../loginIdentifierMethod';

/**
 * 分区互斥拍板(2026-07-21):cn=手机、global=邮箱;服务端组合永不产生双形态。
 * 与 desktop shared/loginIdentifierMethod.test 同用例集(双端语义镜像)。
 */
describe('resolveIdentifierMethod(mobile)', () => {
  it('cn:双方式下发也只取手机', () => {
    expect(resolveIdentifierMethod('cn', { email: true, phone: true })).toBe('phone');
  });

  it('global:双方式下发也只取邮箱', () => {
    expect(resolveIdentifierMethod('global', { email: true, phone: true })).toBe('email');
  });

  it('dev:随区域回落取手机', () => {
    expect(resolveIdentifierMethod('dev', { email: true, phone: true })).toBe('phone');
  });

  it('cn:服务端只发邮箱 → 落到邮箱单形态(缺失兜底)', () => {
    expect(resolveIdentifierMethod('cn', { email: true, phone: false })).toBe('email');
  });

  it('global:服务端只发手机 → 落到手机单形态', () => {
    expect(resolveIdentifierMethod('global', { email: false, phone: true })).toBe('phone');
  });

  it('两者都未下发 → 维持区域首选', () => {
    expect(resolveIdentifierMethod('cn', { email: false, phone: false })).toBe('phone');
    expect(resolveIdentifierMethod('global', { email: false, phone: false })).toBe('email');
  });
});
