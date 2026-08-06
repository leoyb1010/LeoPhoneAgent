/**
 * 全窗拖入拦截契约测试(lib/globalDropIntercept.ts):
 * 扩展名路由判定(大小写 / 旧扩展名)+ drop 事件标记的读写语义。
 */
import { describe, expect, it } from 'vitest';

import {
  classifyGlobalDropPath,
  isGlobalDropIntercepted,
  markGlobalDropIntercepted,
} from '../globalDropIntercept';

describe('classifyGlobalDropPath', () => {
  it('routes .cindy to cindy', () => {
    expect(classifyGlobalDropPath('C:\\a\\b\\pack.cindy')).toBe('cindy');
    expect(classifyGlobalDropPath('/tmp/Pack.CINDY')).toBe('cindy');
  });

  it('routes .cshare and legacy .xdtshare', () => {
    expect(classifyGlobalDropPath('/tmp/s.cshare')).toBe('share');
    expect(classifyGlobalDropPath('/tmp/S.CShare')).toBe('share');
    expect(classifyGlobalDropPath('C:\\x\\old.xdtshare')).toBe('share');
  });

  it('returns null for anything else', () => {
    expect(classifyGlobalDropPath('/tmp/readme.md')).toBeNull();
    expect(classifyGlobalDropPath('/tmp/dir')).toBeNull();
    // 扩展名必须是后缀,不能只是路径中段出现
    expect(classifyGlobalDropPath('/tmp/a.cindy.txt')).toBeNull();
    expect(classifyGlobalDropPath('/tmp/a.cshare.bak')).toBeNull();
  });
});

describe('drop event intercept mark', () => {
  it('marks and reads back the same event instance', () => {
    const e = new Event('drop');
    expect(isGlobalDropIntercepted(e)).toBe(false);
    markGlobalDropIntercepted(e);
    expect(isGlobalDropIntercepted(e)).toBe(true);
  });

  it('does not leak the mark across event instances', () => {
    const a = new Event('drop');
    const b = new Event('drop');
    markGlobalDropIntercepted(a);
    expect(isGlobalDropIntercepted(b)).toBe(false);
  });
});
