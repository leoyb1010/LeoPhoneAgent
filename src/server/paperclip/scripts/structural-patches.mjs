import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { localizeDisplayFormats } from './display-locales.mjs';
import { extract } from './localization-engine.mjs';
const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function applyStructuralPatches({ root, changed, report }) {
  const read = file => changed.get(file) ?? execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 20_000_000 });
  function replace(file, from, to, expected = 1) {
    const input = read(file);
    const count = input.split(from).length - 1;
    if (count !== expected) throw new Error(`结构补丁上下文不匹配：${file} 预期 ${expected}，实际 ${count}: ${from.slice(0, 100)}`);
    changed.set(file, input.split(from).join(to));
    if (!report.structuralFiles.includes(file)) report.structuralFiles.push(file);
  }
  function overlay(file, name) { changed.set(file, fs.readFileSync(path.join(home, 'overlays', name), 'utf8')); report.structuralFiles.push(file); }
  replace('ui/src/i18n/locales.ts', 'DEFAULT_LOCALE = "en"', 'DEFAULT_LOCALE = "zh-CN"');
  replace('ui/index.html', 'lang="en"', 'lang="zh-CN"');
  replace('ui/src/i18n/locales/zh-CN.json', '创建您的第一家公司', '创建你的第一个组织');
  replace('ui/src/i18n/locales/zh-CN.json', '通过创建公司开始。', '创建组织，开始协作。');
  replace('ui/src/i18n/locales/zh-CN.json', '新公司', '创建组织');
  for (const [en, zh] of Object.entries({
    'Paperclip couldn’t start': 'Paperclip 无法启动',
    'Part of the app failed to load. Check your connection and reload this page to try again.': '部分应用资源加载失败。请检查网络连接，然后重新加载页面。',
    'Reload page': '重新加载页面',
    'Paperclip is taking longer to load': 'Paperclip 加载时间较长',
    'You can keep waiting, or reload this page to try again.': '你可以继续等待，或重新加载此页面再试。',
  })) replace('ui/index.html', en, zh, en === 'Paperclip couldn’t start' || en.startsWith('Part of') ? 2 : 1);
  overlay('ui/src/i18n/zh-CN.ts', 'zh-CN.ts');
  overlay('ui/src/i18n/editor.zh-CN.ts', 'editor.zh-CN.ts');
  replace('ui/src/components/MarkdownEditor.tsx', '<MDXEditor\n', '<MDXEditor\n          translation={editorTranslation}\n');
  const editorPath = 'ui/src/components/MarkdownEditor.tsx';
  changed.set(editorPath, 'import { editorTranslation } from "@/i18n/editor.zh-CN";\n' + read(editorPath));
  overlay('ui/src/pages/Auth.zh-CN.test.tsx', 'Auth.zh-CN.test.tsx');
  overlay('ui/src/pages/Agents.zh-CN.test.tsx', 'Agents.zh-CN.test.tsx');
  overlay('ui/src/i18n/zh-CN.ui.test.tsx', 'zh-CN.ui.test.tsx');
  overlay('ui/src/i18n/smoke-board-fixture.json', 'smoke-board-fixture.json');
  overlay('ui/src/components/ChineseError.tsx', 'ChineseError.tsx');
  overlay('ui/src/components/ChineseFileInput.tsx', 'ChineseFileInput.tsx');
  overlay('ui/src/lib/timeAgo.ts', 'timeAgo.ts');
  replace('ui/src/lib/utils.ts', '"en-US"', '"zh-CN"', 5);
  replace('ui/src/lib/utils.ts', '`${amount}/mo`', '`${amount}/月`');
  replace('ui/src/components/StatusBadge.tsx', 'import type { CSSProperties }', 'import { displayStatus } from "@/i18n/zh-CN";\nimport type { CSSProperties }');
  replace('ui/src/components/StatusBadge.tsx', 'const s = status.replace(/_/g, " ");\n  return s.charAt(0).toUpperCase() + s.slice(1);', 'return displayStatus(status);');
  replace('ui/src/components/StatusBadge.tsx', 'label ?? status.replace(/[_-]/g, " ")', 'label ?? displayStatus(status)');
  replace('ui/src/components/StatusBadge.tsx', 'label.replace(/_/g, " ")', 'displayStatus(label)');
  replace('ui/src/components/ApprovalCard.tsx', 'import { AgentIdentity }', 'import { displayStatus } from "@/i18n/zh-CN";\nimport { AgentIdentity }');
  replace('ui/src/components/ApprovalCard.tsx', 'approval.status.replace(/_/g, " ")', 'displayStatus(approval.status)');
  // Localize only direct rendered errors. The Error itself, response body and
  // string comparisons remain untouched, including Document-is-locked checks.
  for (const file of Object.keys(report.files).filter(f => f.endsWith('.tsx'))) {
    let source = read(file);
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const edits = [];
    function visit(n) {
      if (ts.isJsxExpression(n) && n.expression && !ts.isJsxAttribute(n.parent)) {
        const parentTag = n.parent.openingElement?.tagName.getText();
        if (!['pre', 'code', 'script', 'style'].includes(parentTag)) {
          const value = n.expression.getText(ast);
          let error = null;
          if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.message$/.test(value) && /error|err/i.test(value)) error = value.slice(0, -8);
          else if (/^(?:error|actionError|submitError|formError|saveError|uploadError|authError|claimError|loadError)$/.test(value)) error = value;
          // Conditional error.message fallbacks are also a display boundary;
          // preserve the original expression and Error, localize only its rendering.
          if (!error && ts.isConditionalExpression(n.expression) && /(?:instanceof Error|\.error)/.test(n.expression.condition.getText(ast))) {
            const scalar = branch => ts.isStringLiteral(branch) || (ts.isPropertyAccessExpression(branch) && branch.name.text === "message");
            if (scalar(n.expression.whenTrue) && scalar(n.expression.whenFalse) && /(?:error|err)[\w$.?]*\.message/i.test(value)) error = value;
          }
          if (error) edits.push({ start: n.getStart(ast), end: n.end, text: `<ChineseError error={${error}} />` });
        }
      }
      ts.forEachChild(n, visit);
    }
    visit(ast);
    if (edits.length) {
      for (const e of edits.toSorted((a, b) => b.start - a.start)) source = source.slice(0, e.start) + e.text + source.slice(e.end);
      source = 'import { ChineseError } from "@/components/ChineseError";\n' + source;
      extract(source, file);
      changed.set(file, source);
      report.structuralFiles.push(file);
    }
  }
  report.displayLocaleSites = 0;
  for (const file of Object.keys(report.files)) {
    const localized = localizeDisplayFormats(read(file), file);
    if (localized.count > 0) { changed.set(file, localized.output); report.displayLocaleSites += localized.count; }
  }
  for (const [file, value] of changed) if (/\.(tsx|ts)$/.test(file)) extract(value, file);
}
