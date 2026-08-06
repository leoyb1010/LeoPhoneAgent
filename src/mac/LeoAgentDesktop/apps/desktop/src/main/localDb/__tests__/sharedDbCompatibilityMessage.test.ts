import { describe, expect, it } from 'vitest';

import { buildSharedDbCompatibilityMessage } from '../sharedDbCompatibilityMessage';

describe('buildSharedDbCompatibilityMessage', () => {
  it('directs a newer shared database to a compatible checkout instead of primary migration', () => {
    const message = buildSharedDbCompatibilityMessage({
      compatible: false,
      databaseVersion: 8,
      checkoutVersion: 7,
      issues: [{ kind: 'schema-version-ahead', databaseVersion: 8, checkoutVersion: 7 }],
    });

    expect(message).toContain('请使用包含该 schema 的 checkout 启动开发版');
    expect(message).toContain('不会降级数据库');
    expect(message).not.toContain('完成迁移');
  });

  it('directs a shared database behind the checkout to primary migration', () => {
    const message = buildSharedDbCompatibilityMessage({
      compatible: false,
      databaseVersion: 7,
      checkoutVersion: 8,
      issues: [{ kind: 'schema-version-behind', databaseVersion: 7, checkoutVersion: 8 }],
    });

    expect(message).toContain('用当前 checkout 作为 primary 完成迁移');
  });

  it('does not direct history or runtime identity mismatches to primary migration', () => {
    const message = buildSharedDbCompatibilityMessage({
      compatible: false,
      databaseVersion: 7,
      checkoutVersion: 7,
      issues: [{ kind: 'runtime-manifest-mismatch' }],
    });

    expect(message).toContain('schema、migration 记录或运行时身份');
    expect(message).toContain('请使用与该数据匹配的 checkout，或改用 --isolated');
    expect(message).not.toContain('作为 primary 完成迁移');
  });

  it('does not direct mixed version and history mismatches to primary migration', () => {
    const message = buildSharedDbCompatibilityMessage({
      compatible: false,
      databaseVersion: 7,
      checkoutVersion: 8,
      issues: [
        { kind: 'schema-version-behind', databaseVersion: 7, checkoutVersion: 8 },
        { kind: 'history-entry-missing', seq: 7, fileName: '0007_missing.sql' },
      ],
    });

    expect(message).toContain('schema、migration 记录或运行时身份');
    expect(message).toContain('请使用与该数据匹配的 checkout，或改用 --isolated');
    expect(message).not.toContain('作为 primary 完成迁移');
  });
});
