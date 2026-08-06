/**
 * decodeAttachments 单测: 入站 base64 附件 -> 图片/文件分流的解码字节;
 * sanitizeAttachmentName 单测: 对端不可信文件名 -> 安全落盘名。
 * 纯函数(不落盘 / 不碰 electron); 图片落盘安全由 imageCacheStore 层保证,
 * 文件落盘由 session-runner 以消毒名 + 随机前缀写 hook 附件目录。
 */

import { describe, expect, it } from 'vitest';

import type { TaskAttachment } from '@cindy/slack-hook-protocol';

import { decodeAttachments, sanitizeAttachmentName } from '../attachments';

const noopLog = { warn: () => {} };

/** 1x1 PNG 的 base64(合法字节)。 */
const PNG_1PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function att(overrides: Partial<TaskAttachment> = {}): TaskAttachment {
  return { name: 'shot.png', mimeType: 'image/png', dataBase64: PNG_1PX_B64, ...overrides };
}

describe('decodeAttachments', () => {
  it('受支持图片: 归入 images, mimeType / name 透传', () => {
    const out = decodeAttachments([att()], noopLog);
    expect(out.images).toHaveLength(1);
    expect(out.files).toHaveLength(0);
    expect(out.images[0].mimeType).toBe('image/png');
    expect(out.images[0].name).toBe('shot.png');
    expect(out.images[0].bytes.length).toBeGreaterThan(0);
    expect(out.skipped).toBe(0);
  });

  it('name 原样透传(不参与落盘路径, 落盘安全在 imageCacheStore 层保证)', () => {
    const out = decodeAttachments([att({ name: '../../evil.png' })], noopLog);
    expect(out.images).toHaveLength(1);
    expect(out.images[0].name).toBe('../../evil.png');
  });

  it('非图片 MIME 归入 files(不再丢弃 —— server 已全类型转发)', () => {
    const out = decodeAttachments(
      [
        att({ name: 'spec.pdf', mimeType: 'application/pdf' }),
        att({ name: 'a.txt', mimeType: 'text/plain' }),
      ],
      noopLog,
    );
    expect(out.images).toHaveLength(0);
    expect(out.files).toHaveLength(2);
    expect(out.files[0]).toMatchObject({ name: 'spec.pdf', mimeType: 'application/pdf' });
    expect(out.files[0].bytes.length).toBeGreaterThan(0);
  });

  it('白名单外的图片格式(bmp/svg/heic)按文件分流, 不再静默丢弃', () => {
    const out = decodeAttachments(
      [
        att({ mimeType: 'image/bmp' }),
        att({ mimeType: 'image/svg+xml' }),
        att({ mimeType: 'image/heic' }),
        att({ mimeType: 'image/png' }), // 仅这张按图片走
      ],
      noopLog,
    );
    expect(out.images).toHaveLength(1);
    expect(out.images[0].mimeType).toBe('image/png');
    expect(out.files).toHaveLength(3);
  });

  it('image/jpg 别名归一为 image/jpeg(图片支路)', () => {
    const out = decodeAttachments([att({ mimeType: 'image/jpg' })], noopLog);
    expect(out.images).toHaveLength(1);
    expect(out.images[0].mimeType).toBe('image/jpeg');
  });

  it('空 base64 跳过, 不影响其它附件(图片与文件同规则)', () => {
    const out = decodeAttachments(
      [
        att({ dataBase64: '' }),
        att(),
        att({ name: 'x.pdf', mimeType: 'application/pdf', dataBase64: '' }),
      ],
      noopLog,
    );
    expect(out.images).toHaveLength(1);
    expect(out.files).toHaveLength(0);
    expect(out.skipped).toBe(2);
  });

  it('图文混合各自解出独立字节', () => {
    const out = decodeAttachments(
      [att(), att({ name: 'spec.pdf', mimeType: 'application/pdf' })],
      noopLog,
    );
    expect(out.images).toHaveLength(1);
    expect(out.files).toHaveLength(1);
  });
});

describe('sanitizeAttachmentName', () => {
  it('普通文件名原样保留(含中文与空格)', () => {
    expect(sanitizeAttachmentName('报告 v2.pdf')).toBe('报告 v2.pdf');
  });

  it('路径穿越: 只取 basename, 首部点号剥掉', () => {
    expect(sanitizeAttachmentName('../../evil.png')).toBe('evil.png');
    expect(sanitizeAttachmentName('..\\..\\evil.png')).toBe('evil.png');
  });

  it('Windows 保留字符与控制字符替换为下划线', () => {
    expect(sanitizeAttachmentName('a<b>:c"|d?*.txt')).toBe('a_b__c__d__.txt');
    expect(sanitizeAttachmentName('bad\u0000name.txt')).toBe('bad_name.txt');
  });

  it('Windows 设备保留名加前缀，普通相似名称不受影响', () => {
    expect(sanitizeAttachmentName('CON')).toBe('_CON');
    expect(sanitizeAttachmentName('nul.txt')).toBe('_nul.txt');
    expect(sanitizeAttachmentName('LPT9.log')).toBe('_LPT9.log');
    expect(sanitizeAttachmentName('console.txt')).toBe('console.txt');
  });

  it('空 / null / 全非法字符回退 attachment', () => {
    expect(sanitizeAttachmentName(null)).toBe('attachment');
    expect(sanitizeAttachmentName('')).toBe('attachment');
    expect(sanitizeAttachmentName('...')).toBe('attachment');
  });

  it('超长截断到 120 字符', () => {
    expect(sanitizeAttachmentName('a'.repeat(300)).length).toBe(120);
  });
});
