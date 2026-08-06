/**
 * parseOmnibox 单测 —— 覆盖 omnibox 输入归一化的所有边界 case。
 *
 * 重点验:
 *   A) 显式 scheme(http/https/about/file/...)原文透传
 *   B) 无 scheme 含 `.` → 加 https
 *   B') 无 scheme 但 host:port(localhost:3000 / 127.0.0.1:8080)→ 加 https
 *   C) 空 / 纯空格 / 含空格短语 / 中文短语 → Google 搜索
 *   D) 边界:大小写 scheme / 前后空格修剪 / 异常输入
 */

import { describe, expect, it } from 'vitest';

import { parseOmnibox } from '../parseOmnibox';

describe('parseOmnibox', () => {
  it('returns about:blank for empty / whitespace-only input', () => {
    expect(parseOmnibox('')).toBe('about:blank');
    expect(parseOmnibox('   ')).toBe('about:blank');
    expect(parseOmnibox('\t\n')).toBe('about:blank');
  });

  it('passes explicit URL schemes through unchanged', () => {
    expect(parseOmnibox('https://github.com')).toBe('https://github.com');
    expect(parseOmnibox('http://example.com')).toBe('http://example.com');
    expect(parseOmnibox('about:blank')).toBe('about:blank');
    expect(parseOmnibox('file:///tmp/foo.html')).toBe('file:///tmp/foo.html');
    expect(parseOmnibox('ftp://files.example.com')).toBe('ftp://files.example.com');
    expect(parseOmnibox('data:text/html,<h1>hi</h1>')).toBe('data:text/html,<h1>hi</h1>');
  });

  it('scheme detection is case-insensitive', () => {
    expect(parseOmnibox('HTTPS://github.com')).toBe('HTTPS://github.com');
    expect(parseOmnibox('Http://example.com')).toBe('Http://example.com');
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseOmnibox('  https://github.com  ')).toBe('https://github.com');
    expect(parseOmnibox('  github.com  ')).toBe('https://github.com');
  });

  it('adds https:// prefix to bare domains (contains a dot)', () => {
    expect(parseOmnibox('github.com')).toBe('https://github.com');
    expect(parseOmnibox('react.dev')).toBe('https://react.dev');
    expect(parseOmnibox('docs.python.org/3/library/json.html')).toBe(
      'https://docs.python.org/3/library/json.html',
    );
    expect(parseOmnibox('foo.bar')).toBe('https://foo.bar'); // 未注册也按 host 处理
  });

  it('adds https:// prefix to bare IPv4', () => {
    expect(parseOmnibox('1.1.1.1')).toBe('https://1.1.1.1');
    expect(parseOmnibox('127.0.0.1')).toBe('https://127.0.0.1');
    expect(parseOmnibox('192.168.1.1:8080')).toBe('https://192.168.1.1:8080');
  });

  it('adds https:// prefix to localhost / host:port without dot', () => {
    expect(parseOmnibox('localhost:3000')).toBe('https://localhost:3000');
    expect(parseOmnibox('myhost:8080')).toBe('https://myhost:8080');
  });

  it('falls through to Google search for plain words (no dot, no port)', () => {
    expect(parseOmnibox('react')).toBe('https://www.google.com/search?q=react');
    expect(parseOmnibox('javascript')).toBe(
      'https://www.google.com/search?q=javascript',
    );
    // 大写 / 数字混合的单词,也归搜索
    expect(parseOmnibox('OpenAI')).toBe('https://www.google.com/search?q=OpenAI');
  });

  it('treats any input with whitespace as a search query', () => {
    expect(parseOmnibox('react hooks tutorial')).toBe(
      'https://www.google.com/search?q=react%20hooks%20tutorial',
    );
    // 中文带空格
    expect(parseOmnibox('如何 写 javascript')).toBe(
      'https://www.google.com/search?q=' +
        encodeURIComponent('如何 写 javascript'),
    );
  });

  it('encodes special chars properly when going to search', () => {
    expect(parseOmnibox('a+b')).toBe('https://www.google.com/search?q=a%2Bb');
    expect(parseOmnibox('foo&bar')).toBe('https://www.google.com/search?q=foo%26bar');
  });

  it('CJK queries without dot/host shape go to search', () => {
    expect(parseOmnibox('黑神话悟空')).toBe(
      'https://www.google.com/search?q=' + encodeURIComponent('黑神话悟空'),
    );
  });

  it('odd inputs: only dots, port-only colon, fall back to search', () => {
    // 全是点 → 不视为 host
    expect(parseOmnibox('...')).toBe(
      'https://www.google.com/search?q=' + encodeURIComponent('...'),
    );
    // foo:bar — `:` 后不是端口号
    expect(parseOmnibox('foo:bar')).toBe('https://www.google.com/search?q=foo%3Abar');
  });

  it('"hello:world" without port-shaped suffix goes to search', () => {
    expect(parseOmnibox('hello:world')).toBe(
      'https://www.google.com/search?q=hello%3Aworld',
    );
  });

  it('supports Chrome-style Ctrl+Enter completion for bare labels only', () => {
    expect(parseOmnibox('taptap', { ctrlEnter: true })).toBe('https://www.taptap.com');
    expect(parseOmnibox('  github  ', { ctrlEnter: true })).toBe('https://www.github.com');
    expect(parseOmnibox('taptap.cn', { ctrlEnter: true })).toBe('https://taptap.cn');
    expect(parseOmnibox('docs/python', { ctrlEnter: true })).toBe(
      'https://www.google.com/search?q=docs%2Fpython',
    );
    expect(parseOmnibox('react hooks', { ctrlEnter: true })).toBe(
      'https://www.google.com/search?q=react%20hooks',
    );
  });
});
