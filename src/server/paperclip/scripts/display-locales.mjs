import ts from 'typescript';

// Date and number formatting is presentation-only in these reviewed UI files.
// Do not alter lib/cron-fires.ts: its en-US formatToParts is a machine parser.
export function usesDisplayLocale(file) {
  return file.endsWith('.tsx') || [
    'ui/src/lib/utils.ts', 'ui/src/lib/attention.ts', 'ui/src/lib/issue-monitor.ts',
    'ui/src/lib/issue-change-receipt.ts', 'ui/src/components/task-chat/task-chat-adapter.ts',
  ].includes(file);
}
export function localizeDisplayFormats(source, file) {
  if (!usesDisplayLocale(file)) return { output: source, count: 0 };
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const edits = [];
  function visit(node) {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const args = node.arguments ?? [];
      const expression = node.expression;
      const isLocaleMethod = ts.isPropertyAccessExpression(expression) && /^toLocale(?:Date|Time)?String$/.test(expression.name.text);
      const isDateFormatter = expression.getText(ast) === 'Intl.DateTimeFormat';
      // No-arg DateTimeFormat().resolvedOptions().timeZone is locale-independent
      // environment discovery, not a visible date; keep it byte-for-byte.
      if (isLocaleMethod || (isDateFormatter && args.length > 0)) {
        const first = args[0];
        if (!first && isLocaleMethod) {
          edits.push({ start: node.end - 1, end: node.end - 1, value: '"zh-CN"' });
        } else if (first && ((ts.isIdentifier(first) && first.text === 'undefined') || (ts.isArrayLiteralExpression(first) && first.elements.length === 0) || (ts.isStringLiteral(first) && first.text === 'en-US'))) {
          edits.push({ start: first.getStart(ast), end: first.end, value: '"zh-CN"' });
        } else if (first && file === 'ui/src/lib/issue-monitor.ts' && first.getText(ast) === 'options.locale') {
          edits.push({ start: first.getStart(ast), end: first.end, value: 'options.locale ?? "zh-CN"' });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  let output = source;
  for (const e of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, e.start) + e.value + output.slice(e.end);
  return { output, count: edits.length };
}
