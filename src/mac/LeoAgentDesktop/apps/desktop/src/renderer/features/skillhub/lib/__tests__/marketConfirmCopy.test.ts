import { describe, expect, it } from 'vitest';

import zhCNCommon from '@/i18n/locales/zh-CN/common.json';

describe('market confirmation copy', () => {
  it('names the skill in the delete impact description', () => {
    const copy = zhCNCommon.skillhub.marketConfirm.deleteDesc;

    expect(copy).toContain('{{name}}');
    expect(copy).not.toContain('这个云端发布物');
  });
});
