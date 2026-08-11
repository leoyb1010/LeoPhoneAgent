import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [fullPath] : [];
  });
}

test('every visible Mac button declares a real interaction contract', () => {
  const missingActions: string[] = [];
  const emptyActions: string[] = [];

  for (const file of sourceFiles('src')) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const tag = opening.tagName.getText(source);
        if (tag === 'button' || tag === 'Button') {
          const attributes = opening.attributes.properties;
          const names = new Set(
            attributes.filter(ts.isJsxAttribute).map((attribute) => attribute.name.getText(source)),
          );
          const hasHandler = ['onClick', 'onPointerUp', 'onMouseUp', 'onTouchEnd', 'onKeyDown']
            .some((name) => names.has(name));
          const isSubmit = attributes.some((attribute) => (
            ts.isJsxAttribute(attribute)
            && attribute.name.getText(source) === 'type'
            && attribute.initializer?.getText(source).includes('submit')
          ));
          const isDisabled = names.has('disabled');
          const spreadsProps = attributes.some(ts.isJsxSpreadAttribute);
          const line = source.getLineAndCharacterOfPosition(opening.getStart(source)).line + 1;

          if (!hasHandler && !isSubmit && !isDisabled && !spreadsProps) {
            missingActions.push(`${file}:${line}`);
          }

          for (const attribute of attributes.filter(ts.isJsxAttribute)) {
            if (!attribute.name.getText(source).startsWith('on') || !attribute.initializer || !ts.isJsxExpression(attribute.initializer)) continue;
            const expression = attribute.initializer.expression;
            if (expression && ts.isArrowFunction(expression) && ts.isBlock(expression.body) && expression.body.statements.length === 0) {
              emptyActions.push(`${file}:${line}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  assert.deepEqual(missingActions, [], `buttons without an action: ${missingActions.join(', ')}`);
  assert.deepEqual(emptyActions, [], `buttons with empty handlers: ${emptyActions.join(', ')}`);
});
