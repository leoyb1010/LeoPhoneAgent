import ts from 'typescript';
import { createHash } from 'node:crypto';

export const normalize = value => value.replace(/\s+/g, ' ').trim();
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const displayFields = new Set(['label', 'title', 'description', 'placeholder', 'aria-label', 'aria-description', 'alt', 'message', 'tooltip', 'help', 'subtitle', 'emptyMessage', 'emptyText', 'loadingText', 'errorMessage', 'confirmLabel', 'cancelLabel', 'buttonText', 'heading', 'summary', 'displayName', 'hint', 'helperText', 'chooseLabel', 'defaultLabel', 'detectModelLabel', 'emptyDetectHint', 'mobileTitle', 'noneLabel', 'searchPlaceholder', 'primaryLabel', 'instruction']);
const displayCalls = /^(?:set(?:Action|Submit|Form|Auth|Upload|Save|Inline)?Error|alert|confirm)$/;
const displayVariables = /(?:LABELS|Labels|Label|LabelsByType|Descriptions|Tooltips|Hints|Messages|Copy|DisplayNames|statusConfig|priorityConfig|PRESET_LABELS|typeLabel)$/;
function keyName(n) { return n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : ''; }
function inToast(n) {
  for (let p = n.parent, d = 0; p && d < 5; p = p.parent, d++) if (ts.isCallExpression(p)) return p.expression.getText() === "pushToast";
  return false;
}
function inDisplayMap(n) {
  for (let p = n.parent, depth = 0; p && depth < 6; p = p.parent, depth++) {
    if (ts.isVariableDeclaration(p)) return displayVariables.test(keyName(p.name));
    if (ts.isCallExpression(p) || ts.isFunctionDeclaration(p) || ts.isArrowFunction(p)) return false;
  }
  return false;
}
function visiblePosition(n) {
  if (ts.isJsxText(n)) {
    const opening = n.parent.openingElement;
    return !opening || !['code', 'pre', 'script', 'style'].includes(opening.tagName.getText());
  }
  let child = n;
  for (let p = n.parent, depth = 0; p && depth < 12; child = p, p = p.parent, depth++) {
    if (ts.isJsxAttribute(p)) return displayFields.has(keyName(p.name));
    if (ts.isPropertyAssignment(p)) return p.initializer === child && ((displayFields.has(keyName(p.name)) && n.getSourceFile().fileName.endsWith(".tsx")) || (keyName(p.name) === "body" && inToast(p)) || inDisplayMap(p));
    if (ts.isJsxExpression(p)) {
      if (ts.isJsxAttribute(p.parent)) return displayFields.has(keyName(p.parent.name));
      const opening = p.parent.openingElement;
      return !opening || !['code', 'pre', 'script', 'style'].includes(opening.tagName.getText());
    }
    if (ts.isConditionalExpression(p)) { if (p.condition === child) return false; continue; }
    if (ts.isBinaryExpression(p)) {
      if (p.right !== child || ![ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(p.operatorToken.kind)) return false;
      continue;
    }
    if (ts.isParenthesizedExpression(p)) continue;
    if (ts.isCallExpression(p)) {
      const callee = p.expression.getText();
      return displayCalls.test(callee) || /^(?:toast|addToast)\.(?:success|error|info|warning)$/.test(callee);
    }
    if (ts.isParameter(p) || ts.isBindingElement(p)) return displayFields.has(keyName(p.name));
    if (ts.isArrayLiteralExpression(p)) return inDisplayMap(p);
    if (ts.isVariableDeclaration(p)) return displayVariables.test(keyName(p.name));
    return false;
  }
  return false;
}
export function extract(source, file = 'source.tsx') {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw new Error(`Cannot parse ${file}: ${ts.flattenDiagnosticMessageText(ast.parseDiagnostics[0].messageText, '\n')}`);
  const entries = [];
  function visit(node) {
    const kind = ts.isJsxText(node) ? 'jsx' : ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? 'literal' : null;
    if (kind && visiblePosition(node)) {
      const original = kind === 'jsx' ? node.getText(ast) : node.text;
      const text = normalize(original);
      if (/[A-Za-z]/.test(text)) entries.push({ text, original, start: node.getStart(ast), end: node.end, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, kind });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return entries;
}
export function translationFor(entry, catalog, context = {}) {
  const key = `${entry.line}:${entry.text}`;
  if (Object.hasOwn(context, key)) return context[key];
  if (Object.hasOwn(context, entry.text)) return context[entry.text];
  return Object.hasOwn(catalog, entry.text) ? catalog[entry.text] : undefined;
}
export function transform(source, file, catalog, context = {}) {
  const entries = extract(source, file);
  const edits = entries.filter(e => translationFor(e, catalog, context) !== undefined && translationFor(e, catalog, context) !== e.text).map(e => {
    const zh = translationFor(e, catalog, context);
    // Literal source translations only. User expressions, keys, routes, commands,
    // comparison operands and API payload values are never recursively translated.
    const replacement = e.kind === 'jsx'
      ? `${e.original.match(/^\s*/)[0]}{${JSON.stringify(zh)}}${e.original.match(/\s*$/)[0]}`
      : JSON.stringify(zh);
    return { ...e, replacement };
  });
  let output = source;
  for (const e of edits.toSorted((a, b) => b.start - a.start)) output = output.slice(0, e.start) + e.replacement + output.slice(e.end);
  // Parsing the result is mandatory: translations must not introduce malformed JSX.
  extract(output, file);
  return { output, entries, edits };
}
