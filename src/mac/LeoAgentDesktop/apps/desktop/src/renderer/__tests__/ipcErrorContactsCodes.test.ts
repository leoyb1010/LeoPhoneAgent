/**
 * 回归: IDENTITY_CONFLICT 曾只加进 IpcErrorCode 类型联合、漏加运行时
 * IPC_ERROR_CODES 集合 — extractIpcError 对 [IDENTITY_CONFLICT] 前缀返回
 * null, UI 落到通用 INTERNAL 兜底文案, 专属冲突引导(i18n)永远展示不出来。
 * 类型联合与运行时集合是两份清单, typecheck 拦不住这类漂移, 只能测试钉住。
 */
import { describe, expect, it } from 'vitest';

import { extractIpcError, mapIpcErrorToI18nKey } from '../utils/ipcError';

describe('extractIpcError — contacts 错误码', () => {
  it('IDENTITY_CONFLICT 在运行时集合内, [CODE] 前缀可解出', () => {
    const err = new Error('[IDENTITY_CONFLICT] identity already owned by another contact');
    expect(extractIpcError(err)).toEqual({
      code: 'IDENTITY_CONFLICT',
      message: 'identity already owned by another contact',
    });
    expect(mapIpcErrorToI18nKey(err, { namespace: 'settings.contacts.ipcError' })).toBe(
      'settings.contacts.ipcError.IDENTITY_CONFLICT',
    );
  });
});
