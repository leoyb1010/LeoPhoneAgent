import { describe, expect, it } from 'vitest';

import { findCindyFileInArgv } from '../argv';

describe('findCindyFileInArgv · 双击 .cindy 的启动参数识别', () => {
  it('冷启动形态:exe 后跟文件路径', () => {
    expect(findCindyFileInArgv(['app.exe', 'C:\\Users\\a\\Desktop\\hello.cindy'])).toBe(
      'C:\\Users\\a\\Desktop\\hello.cindy',
    );
  });

  it('packaged 常见形态:中间夹着 --flag,取末尾文件参数;大小写后缀都认', () => {
    expect(
      findCindyFileInArgv(['app.exe', '--allow-file-access', 'D:\\carts\\Tool.CINDY']),
    ).toBe('D:\\carts\\Tool.CINDY');
  });

  it('argv[0](exe 自身)不参与匹配 —— 防止 exe 恰好叫 *.cindy 的荒诞误判', () => {
    expect(findCindyFileInArgv(['evil.cindy'])).toBeNull();
  });

  it('无 .cindy 参数 / 只有 flags / 其它文件 → null', () => {
    expect(findCindyFileInArgv(['app.exe'])).toBeNull();
    expect(findCindyFileInArgv(['app.exe', '--open-folder', 'C:\\proj'])).toBeNull();
    expect(findCindyFileInArgv(['app.exe', 'C:\\a\\b.xdtshare'])).toBeNull();
  });

  it('多个候选取最后一个(OS 追加语义,最后者为本次双击目标)', () => {
    expect(findCindyFileInArgv(['app.exe', 'a.cindy', 'b.cindy'])).toBe('b.cindy');
  });
});
