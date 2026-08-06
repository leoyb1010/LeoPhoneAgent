import { Facet, RangeSetBuilder, StateField, type ChangeSpec } from '@codemirror/state';
import { redo, undo } from '@codemirror/commands';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

export type TableMenuLabels = Record<TableAction, string>;

const defaultTableMenuLabels: TableMenuLabels = {
  'add-row-above': '在上方新增行',
  'add-row-below': '在下方新增行',
  'delete-row': '删除行',
  'add-column-left': '在左侧新增列',
  'add-column-right': '在右侧新增列',
  'delete-column': '删除列',
  'delete-table': '删除表格',
};

export const tableMenuLabelsFacet = Facet.define<TableMenuLabels, TableMenuLabels>({
  combine: (values) => values[0] ?? defaultTableMenuLabels,
});

const tableMenuCleanup = new WeakMap<HTMLElement, () => void>();

export interface MarkdownTableCell {
  text: string;
  sourceFrom?: number;
  sourceTo?: number;
}

export interface MarkdownTableModel {
  header: MarkdownTableCell[];
  aligns: Array<'left' | 'center' | 'right' | null>;
  rows: MarkdownTableCell[][];
  sourceWidths: number[];
}

export interface MarkdownTableBlock {
  from: number;
  to: number;
  text: string;
  model: MarkdownTableModel;
}

type TableAction =
  | 'add-row-above'
  | 'add-row-below'
  | 'delete-row'
  | 'add-column-left'
  | 'add-column-right'
  | 'delete-column'
  | 'delete-table';

type TableMenuEntry =
  | { type: 'item'; action: TableAction; label: string }
  | { type: 'separator' };

export const markdownTableDecorationField = StateField.define({
  create(state) {
    return buildMarkdownTableDecorations(state.doc);
  },
  update(value, transaction) {
    if (!transaction.docChanged) return value;
    return buildMarkdownTableDecorations(transaction.state.doc);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function buildMarkdownTableDecorations(doc: EditorView['state']['doc']) {
  const builder = new RangeSetBuilder<Decoration>();
  let line = doc.line(1);
  while (line.number <= doc.lines) {
    const block = findMarkdownTableAtLineInDoc(doc, line.number);
    if (block) {
      const widget = new MarkdownTableWidget(block);
      builder.add(
        block.from,
        block.to,
        Decoration.replace({
          block: true,
          widget,
        }),
      );
      line = doc.lineAt(block.to);
      if (line.to >= doc.length) break;
      line = doc.line(line.number + 1);
      continue;
    }
    if (line.to >= doc.length) break;
    line = doc.line(line.number + 1);
  }
  return builder.finish();
}

export function findMarkdownTableAtLine(
  view: EditorView,
  lineNumber: number,
): MarkdownTableBlock | null {
  return findMarkdownTableAtLineInDoc(view.state.doc, lineNumber);
}

function findMarkdownTableAtLineInDoc(
  doc: EditorView['state']['doc'],
  lineNumber: number,
): MarkdownTableBlock | null {
  if (lineNumber < 1 || lineNumber > doc.lines) return null;

  let start = lineNumber;
  while (start > 1 && isPotentialTableRow(doc.line(start - 1).text)) {
    start--;
  }

  let end = lineNumber;
  while (end < doc.lines && isPotentialTableRow(doc.line(end + 1).text)) {
    end++;
  }

  for (let headerLine = start; headerLine < end; headerLine++) {
    const separatorLine = headerLine + 1;
    if (!isMarkdownTableSeparator(doc.line(separatorLine).text)) continue;

    let blockEnd = separatorLine;
    while (blockEnd < doc.lines && isPotentialTableRow(doc.line(blockEnd + 1).text)) {
      blockEnd++;
    }
    if (lineNumber < headerLine || lineNumber > blockEnd) continue;

    const from = doc.line(headerLine).from;
    const to = doc.line(blockEnd).to;
    const text = doc.sliceString(from, to);
    const model = parseMarkdownTable(text);
    if (!model) return null;
    return { from, to, text, model };
  }

  return null;
}

function isPotentialTableRow(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.includes('|') && trimmed.length > 0;
}

function isMarkdownTableSeparator(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const cells = splitMarkdownTableRow(text).map((cell) => cell.trim());
  if (cells.length < 2) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function parseMarkdownTable(text: string): MarkdownTableModel | null {
  const lines = splitLinesWithOffsets(text);
  if (lines.length < 2 || !isMarkdownTableSeparator(lines[1].text)) return null;

  const headerCells = splitMarkdownTableRowWithRanges(lines[0].text, lines[0].from);
  const separatorCells = splitMarkdownTableRowWithRanges(lines[1].text, lines[1].from);
  const header = headerCells.map((cell) => ({
    text: cell.text.trim(),
    sourceFrom: cell.contentFrom,
    sourceTo: cell.contentTo,
  }));
  const aligns = splitMarkdownTableRow(lines[1].text).map(parseAlignCell);
  if (header.length < 2 || aligns.length < 2) return null;

  const columnCount = Math.max(header.length, aligns.length);
  const rowCells = lines.slice(2).map((line) => splitMarkdownTableRowWithRanges(line.text, line.from));
  const rows = rowCells.map((rawCells) => {
    const cells = rawCells.map((cell) => ({
      text: cell.text.trim(),
      sourceFrom: cell.contentFrom,
      sourceTo: cell.contentTo,
    }));
    return normalizeCells(cells, columnCount);
  });

  return {
    header: normalizeCells(header, columnCount),
    aligns: normalizeAligns(aligns, columnCount),
    rows,
    sourceWidths: computeSourceWidths([headerCells, separatorCells, ...rowCells], separatorCells, columnCount),
  };
}

export function serializeMarkdownTable(
  model: MarkdownTableModel,
  targetWidths = computeColumnWidths(model, getColumnCount(model)),
): string {
  const columnCount = getColumnCount(model);
  const widths = normalizeColumnWidths(targetWidths, columnCount);
  const lines: string[] = [];

  lines.push(serializeTableRow(model.header, widths));
  lines.push(serializeSeparatorRow(model.aligns, widths));
  for (const row of model.rows) {
    lines.push(serializeTableRow(row, widths));
  }

  return lines.join('\n');
}

function splitLinesWithOffsets(text: string): Array<{ text: string; from: number }> {
  const out: Array<{ text: string; from: number }> = [];
  let from = 0;
  for (const line of text.split(/\r?\n/)) {
    out.push({ text: line, from });
    from += line.length + 1;
  }
  return out;
}

function splitMarkdownTableRow(line: string): string[] {
  if (typeof line !== 'string') return [];
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function splitMarkdownTableRowWithRanges(
  line: string,
  lineFrom: number,
): Array<{ text: string; contentFrom: number; contentTo: number; rawWidth: number }> {
  const cells: Array<{ text: string; from: number; to: number }> = [];
  let start = line.startsWith('|') ? 1 : 0;
  let current = '';
  let escaped = false;

  for (let index = start; index < line.length; index++) {
    const char = line[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '|') {
      cells.push({ text: current, from: start, to: index });
      start = index + 1;
      current = '';
      continue;
    }
    current += char;
  }
  if (start < line.length || !line.endsWith('|')) {
    cells.push({ text: current, from: start, to: line.length });
  }

  return cells.map((cell) => {
    const leading = cell.text.match(/^\s*/)?.[0].length ?? 0;
    const trailing = cell.text.match(/\s*$/)?.[0].length ?? 0;
    return {
      text: cell.text,
      contentFrom: lineFrom + cell.from + leading,
      contentTo: lineFrom + cell.to - trailing,
      rawWidth: cell.to - cell.from,
    };
  });
}

function parseAlignCell(cell: string): 'left' | 'center' | 'right' | null {
  const trimmed = cell.trim();
  const left = trimmed.startsWith(':');
  const right = trimmed.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function normalizeCells(cells: MarkdownTableCell[], count: number): MarkdownTableCell[] {
  return Array.from({ length: count }, (_, i) => cells[i] ?? { text: '' });
}

function normalizeAligns(
  aligns: Array<'left' | 'center' | 'right' | null>,
  count: number,
): Array<'left' | 'center' | 'right' | null> {
  return Array.from({ length: count }, (_, i) => aligns[i] ?? null);
}

function computeSourceWidths(
  rows: Array<Array<{ text: string; rawWidth: number }>>,
  separatorCells: Array<{ rawWidth: number }>,
  count: number,
): number[] {
  const separatorWidths = Array.from({ length: count }, (_, index) =>
    Math.max(3, separatorCells[index]?.rawWidth ?? 0),
  );
  const hasManualWidths = new Set(separatorWidths).size > 1;
  if (hasManualWidths) return separatorWidths;

  return Array.from({ length: count }, (_, index) =>
    Math.max(3, ...rows.map((row) => row[index]?.rawWidth ?? 0)),
  );
}

function getColumnCount(model: MarkdownTableModel): number {
  return Math.max(model.header.length, model.aligns.length, ...model.rows.map((row) => row.length));
}

function computeColumnWidths(model: MarkdownTableModel, columnCount: number): number[] {
  return Array.from({ length: columnCount }, (_, index) => {
    const values = [
      model.header[index]?.text ?? '',
      ...model.rows.map((row) => row[index]?.text ?? ''),
    ];
    return Math.max(3, ...values.map((value) => value.length));
  });
}

function normalizeColumnWidths(widths: number[], columnCount: number): number[] {
  return Array.from({ length: columnCount }, (_, index) => Math.max(3, widths[index] ?? 3));
}

function serializeTableRow(cells: MarkdownTableCell[], widths: number[]): string {
  return `| ${widths
    .map((width, index) => padCell(escapeTableCell(cells[index]?.text ?? ''), width))
    .join(' | ')} |`;
}

function serializeSeparatorRow(
  aligns: Array<'left' | 'center' | 'right' | null>,
  widths: number[],
): string {
  return `| ${widths
    .map((width, index) => {
      const minWidth = Math.max(3, width);
      const dashes = '-'.repeat(minWidth);
      const align = aligns[index] ?? null;
      if (align === 'left') return `:${dashes.slice(1)}`;
      if (align === 'right') return `${dashes.slice(0, -1)}:`;
      if (align === 'center') return `:${dashes.slice(2)}:`;
      return dashes;
    })
    .join(' | ')} |`;
}

function padCell(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - text.length));
}

function escapeTableCell(text: string): string {
  return text.replace(/(?<!\\)\|/g, '\\|');
}

class MarkdownTableWidget extends WidgetType {
  constructor(private readonly block: MarkdownTableBlock) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-md-table-widget';
    wrapper.contentEditable = 'false';
    wrapper.appendChild(this.createControls(view, wrapper));
    wrapper.addEventListener('focusin', (event) => {
      const target = getTableCellFromTarget(wrapper, event.target);
      if (!target) return;
      setActiveTableCell(wrapper, target);
      renderTableCells(rootOrSelf(target), target);
    });
    wrapper.addEventListener('pointerdown', (event) => {
      const element = getElementFromEventTarget(event.target);
      if (element.closest('.cm-md-table-controls')) return;
      const cell = getTableCellFromTarget(wrapper, event.target);
      if (cell) {
        setActiveTableCell(wrapper, cell);
      }
      closeTableMenus(wrapper);
    }, true);
    wrapper.addEventListener('contextmenu', (event) => {
      const cell = getTableCellFromTarget(wrapper, event.target);
      if (!cell) return;
      event.preventDefault();
      event.stopPropagation();
      setActiveTableCell(wrapper, cell);
      renderTableCells(rootOrSelf(cell), cell);
      openTableContextMenu(wrapper, cell, event.clientX, event.clientY);
    });
    wrapper.addEventListener('focusout', (event) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && wrapper.contains(nextTarget)) return;
      this.commitTable(view, wrapper);
      renderTableCells(wrapper, null);
    });

    const table = document.createElement('table');
    wrapper.appendChild(table);

    const colgroup = document.createElement('colgroup');
    table.appendChild(colgroup);
    this.block.model.sourceWidths.forEach((width, index) => {
      const col = document.createElement('col');
      col.dataset.column = String(index);
      col.style.width = `${Math.max(3, width)}ch`;
      colgroup.appendChild(col);
    });
    applyColumnWidths(wrapper, this.block.model.sourceWidths);

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    thead.appendChild(headRow);
    table.appendChild(thead);
    this.block.model.header.forEach((cell, columnIndex) => {
      headRow.appendChild(this.createCell(view, 'th', 0, columnIndex, cell.text, wrapper));
    });

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    this.block.model.rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      tbody.appendChild(tr);
      row.forEach((cell, columnIndex) => {
        tr.appendChild(this.createCell(view, 'td', rowIndex + 1, columnIndex, cell.text, wrapper));
      });
    });

    return wrapper;
  }

  ignoreEvent(event: Event): boolean {
    return event.type !== 'blur';
  }

  destroy(dom: HTMLElement): void {
    closeTableMenus(dom);
  }

  eq(other: MarkdownTableWidget): boolean {
    return this.block.text === other.block.text && this.block.from === other.block.from;
  }

  private createControls(view: EditorView, root: HTMLElement): HTMLElement {
    const controls = document.createElement('div');
    controls.className = 'cm-md-table-controls';
    controls.contentEditable = 'false';

    const labels = view.state.facet(tableMenuLabelsFacet);
    controls.appendChild(
      this.createMenu([
        { type: 'item', action: 'add-row-above', label: labels['add-row-above'] },
        { type: 'item', action: 'add-row-below', label: labels['add-row-below'] },
        { type: 'item', action: 'delete-row', label: labels['delete-row'] },
        { type: 'separator' },
        { type: 'item', action: 'add-column-left', label: labels['add-column-left'] },
        { type: 'item', action: 'add-column-right', label: labels['add-column-right'] },
        { type: 'item', action: 'delete-column', label: labels['delete-column'] },
        { type: 'separator' },
        { type: 'item', action: 'delete-table', label: labels['delete-table'] },
      ], view, root),
    );

    return controls;
  }

  private createMenu(
    items: TableMenuEntry[],
    view: EditorView,
    root: HTMLElement,
  ): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'cm-md-table-menu';
    menu.dataset.menu = 'context';
    menu.contentEditable = 'false';

    for (const item of items) {
      if (item.type === 'separator') {
        const separator = document.createElement('div');
        separator.className = 'cm-md-table-menu-separator';
        separator.setAttribute('role', 'separator');
        menu.appendChild(separator);
        continue;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cm-md-table-menu-item';
      button.textContent = item.label;
      button.dataset.action = item.action;
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        if (button.disabled) return;
        closeTableMenus(root);
        this.applyTableAction(view, root, item.action);
      });
      menu.appendChild(button);
    }

    return menu;
  }

  private createCell(
    view: EditorView,
    tag: 'td' | 'th',
    rowIndex: number,
    columnIndex: number,
    text: string,
    root: HTMLElement,
  ): HTMLTableCellElement {
    const cell = document.createElement(tag);
    cell.contentEditable = 'true';
    cell.spellcheck = false;
    cell.dataset.row = String(rowIndex);
    cell.dataset.column = String(columnIndex);
    cell.dataset.sourceText = text;
    renderInlineMarkdown(cell, text);

    if (tag === 'th') {
      const handle = document.createElement('span');
      handle.className = 'cm-md-table-resize-handle';
      handle.contentEditable = 'false';
      handle.setAttribute('aria-hidden', 'true');
      handle.addEventListener('pointerdown', (event) => {
        this.startColumnResize(view, root, columnIndex, event);
      });
      cell.appendChild(handle);
    }

    cell.addEventListener('keydown', (event) => {
      const isMac = window.electronAPI.platform === 'darwin';
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (isUndoShortcut(event, isMac) || isRedoShortcut(event, isMac)) {
        event.preventDefault();
        event.stopPropagation();
        cell.dataset.sourceText = getCellEditingText(cell);
        this.commitTable(view, cell.closest('.cm-md-table-widget'), { preserveFocus: true });
        runHistoryCommandPreservingScroll(view, isUndoShortcut(event, isMac) ? undo : redo);
        return;
      }
      if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleStrongInTableCell(cell);
        return;
      }
      if (
        event.key === 'Enter' &&
        ((isMac && event.metaKey) || (!isMac && event.shiftKey))
      ) {
        event.preventDefault();
        insertTableCellBreak(cell);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        cell.dataset.sourceText = getCellEditingText(cell);
        this.commitTable(view, cell.closest('.cm-md-table-widget'));
        cell.blur();
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        cell.dataset.sourceText = getCellEditingText(cell);
        focusSiblingCell(cell, event.shiftKey ? -1 : 1);
      }
      if (!isNavigationKey(event.key)) {
        window.requestAnimationFrame(() => {
          if (isComposingTableCell(cell)) return;
          renderActiveCell(cell);
        });
      }
    });
    cell.addEventListener('compositionstart', () => {
      cell.dataset.composing = 'true';
    });
    cell.addEventListener('compositionend', () => {
      delete cell.dataset.composing;
      cell.dataset.sourceText = getCellEditingText(cell);
      window.requestAnimationFrame(() => {
        renderActiveCell(cell);
      });
    });
    cell.addEventListener('input', () => {
      if (isComposingTableCell(cell)) return;
      cell.dataset.sourceText = getCellEditingText(cell);
      renderActiveCell(cell);
    });
    cell.addEventListener('mouseup', () => {
      window.requestAnimationFrame(() => {
        setActiveTableCell(root, cell);
        renderActiveCell(cell);
      });
    });

    return cell;
  }

  private startColumnResize(
    view: EditorView,
    root: HTMLElement,
    columnIndex: number,
    event: PointerEvent,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    this.commitTable(view, root, { preserveFocus: true });

    const startX = event.clientX;
    const charPx = estimateCharacterWidth(root);
    const resizeStepPx = Math.max(1, charPx * 0.25);
    const currentModel = readTableModelFromDom(root, this.block.model);
    const columnCount = getColumnCount(currentModel);
    const startWidths = normalizeColumnWidths(this.block.model.sourceWidths, columnCount);
    let nextWidths = [...startWidths];
    applyColumnWidths(root, startWidths);

    const onPointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const deltaChars = Math.round((moveEvent.clientX - startX) / resizeStepPx);
      nextWidths = [...startWidths];
      nextWidths[columnIndex] = Math.max(3, (startWidths[columnIndex] ?? 3) + deltaChars);
      applyColumnWidths(root, nextWidths);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      upEvent.preventDefault();
      const nextModel = readTableModelFromDom(root, this.block.model);
      const serialized = serializeMarkdownTable(nextModel, nextWidths);
      if (serialized === this.block.text) return;
      const tableIndex = getTableWidgetIndex(view, root);
      dispatchTableChange(view, {
        changes: { from: this.block.from, to: this.block.to, insert: serialized },
        selection: { anchor: this.block.from },
      });
      focusRebuiltTableCell(view, tableIndex, 0, columnIndex);
    };

    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
  }

  private applyTableAction(view: EditorView, root: HTMLElement, action: TableAction): void {
    if (action === 'delete-table') {
      dispatchTableChange(view, {
        changes: { from: this.block.from, to: this.block.to, insert: '' },
        selection: { anchor: this.block.from },
      });
      view.focus();
      return;
    }

    const active = getActiveTableCell(root);
    const rowIndex = active?.row ?? 0;
    const columnIndex = active?.column ?? 0;
    const nextModel = mutateTableModel(readTableModelFromDom(root, this.block.model), action, rowIndex, columnIndex);
    if (!nextModel) return;

    const serialized = serializeMarkdownTable(nextModel, nextModel.sourceWidths);
    if (serialized === this.block.text) return;
    const tableIndex = getTableWidgetIndex(view, root);
    dispatchTableChange(view, {
      changes: { from: this.block.from, to: this.block.to, insert: serialized },
      selection: { anchor: this.block.from },
    });
    focusRebuiltTableCell(
      view,
      tableIndex,
      getFocusRowAfterTableAction(action, rowIndex, nextModel),
      getFocusColumnAfterTableAction(action, columnIndex, nextModel),
    );
  }

  private commitTable(
    view: EditorView,
    root: Element | null,
    opts?: { preserveFocus?: boolean },
  ): void {
    if (!root) return;
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    let needsFullSerialize = false;

    for (const cell of root.querySelectorAll<HTMLTableCellElement>('th, td')) {
      const row = Number(cell.dataset.row);
      const column = Number(cell.dataset.column);
      if (!Number.isInteger(row) || !Number.isInteger(column)) continue;
      const nextText = getCellText(cell);
      const original = row === 0 ? this.block.model.header[column] : this.block.model.rows[row - 1]?.[column];
      if (!original || original.text === nextText) continue;
      if (original.sourceFrom == null || original.sourceTo == null) {
        needsFullSerialize = true;
        continue;
      }
      changes.push({
        from: this.block.from + original.sourceFrom,
        to: this.block.from + original.sourceTo,
        insert: escapeTableCell(nextText),
      });
    }

    if (needsFullSerialize) {
      const nextModel = readTableModelFromDom(root, this.block.model);
      const serialized = serializeMarkdownTable(nextModel, nextModel.sourceWidths);
      if (serialized === this.block.text) return;
      dispatchTableChange(view, {
        changes: { from: this.block.from, to: this.block.to, insert: serialized },
        selection: opts?.preserveFocus ? undefined : { anchor: this.block.from },
      });
      return;
    }

    if (changes.length === 0) return;
    changes.sort((a, b) => b.from - a.from);
    dispatchTableChange(view, {
      changes,
      selection: opts?.preserveFocus ? undefined : { anchor: this.block.from },
    });
  }
}

function dispatchTableChange(
  view: EditorView,
  spec: {
    changes: ChangeSpec;
    selection?: { anchor: number };
  },
): void {
  const scrollSnapshot = view.scrollSnapshot();
  const changeDesc = view.state.changes(spec.changes);
  const mappedScrollSnapshot = scrollSnapshot.map(changeDesc);
  view.dispatch({
    changes: spec.changes,
    selection: spec.selection,
    effects: mappedScrollSnapshot ? [mappedScrollSnapshot] : [],
    userEvent: 'input',
  });
}

function getTableWidgetIndex(view: EditorView, root: HTMLElement): number {
  return Array.from(view.dom.querySelectorAll('.cm-md-table-widget')).indexOf(root);
}

function focusRebuiltTableCell(
  view: EditorView,
  tableIndex: number,
  rowIndex: number,
  columnIndex: number,
): void {
  window.requestAnimationFrame(() => {
    const widgets = view.dom.querySelectorAll<HTMLElement>('.cm-md-table-widget');
    const widget = tableIndex >= 0 ? widgets[tableIndex] : null;
    if (!widget) {
      view.focus();
      return;
    }

    const cells = Array.from(widget.querySelectorAll<HTMLTableCellElement>('th, td'));
    const target =
      widget.querySelector<HTMLTableCellElement>(
        `th[data-row="${rowIndex}"][data-column="${columnIndex}"], td[data-row="${rowIndex}"][data-column="${columnIndex}"]`,
      ) ?? cells[Math.min(Math.max(0, rowIndex), cells.length - 1)];

    if (!target) {
      view.focus();
      return;
    }

    target.focus({ preventScroll: true });
    setActiveTableCell(widget, target);
    renderTableCells(widget, target);
    placeCaretAtEnd(target);
  });
}

function getFocusRowAfterTableAction(
  action: TableAction,
  rowIndex: number,
  model: MarkdownTableModel,
): number {
  if (action === 'add-row-below') return Math.min(rowIndex + 1, model.rows.length);
  if (action === 'delete-row') return Math.min(Math.max(1, rowIndex), model.rows.length);
  return rowIndex;
}

function getFocusColumnAfterTableAction(
  action: TableAction,
  columnIndex: number,
  model: MarkdownTableModel,
): number {
  const maxColumn = Math.max(0, getColumnCount(model) - 1);
  if (action === 'add-column-right') return Math.min(columnIndex + 1, maxColumn);
  if (action === 'delete-column') return Math.min(columnIndex, maxColumn);
  return Math.min(columnIndex, maxColumn);
}

const NAVIGATION_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown',
]);

function isNavigationKey(key: string): boolean {
  return NAVIGATION_KEYS.has(key);
}

function isUndoShortcut(event: KeyboardEvent, isMac: boolean): boolean {
  if (event.altKey) return false;
  return (isMac ? event.metaKey : event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
}

function isRedoShortcut(event: KeyboardEvent, isMac: boolean): boolean {
  if (event.altKey) return false;
  const key = event.key.toLowerCase();
  if (isMac) return event.metaKey && event.shiftKey && key === 'z';
  return event.ctrlKey && (key === 'y' || (event.shiftKey && key === 'z'));
}

export function runHistoryCommandPreservingScroll(
  view: EditorView,
  command: (target: EditorView) => boolean,
): boolean {
  const scrollDOM = view.scrollDOM;
  const scrollTop = scrollDOM.scrollTop;
  const scrollLeft = scrollDOM.scrollLeft;
  const handled = command(view);
  if (!handled) return false;
  window.requestAnimationFrame(() => {
    scrollDOM.scrollTop = scrollTop;
    scrollDOM.scrollLeft = scrollLeft;
  });
  return true;
}

function readTableModelFromDom(root: Element, base: MarkdownTableModel): MarkdownTableModel {
  const next: MarkdownTableModel = {
    header: base.header.map((cell) => ({ ...cell })),
    aligns: [...base.aligns],
    rows: base.rows.map((row) => row.map((cell) => ({ ...cell }))),
    sourceWidths: [...base.sourceWidths],
  };

  for (const cell of root.querySelectorAll<HTMLTableCellElement>('th, td')) {
    const row = Number(cell.dataset.row);
    const column = Number(cell.dataset.column);
    if (!Number.isInteger(row) || !Number.isInteger(column)) continue;
    const text = getCellText(cell);
    if (row === 0) {
      next.header[column] = { text };
    } else if (next.rows[row - 1]) {
      next.rows[row - 1][column] = { text };
    }
  }

  return next;
}

function mutateTableModel(
  model: MarkdownTableModel,
  action: TableAction,
  rowIndex: number,
  columnIndex: number,
): MarkdownTableModel | null {
  const columnCount = getColumnCount(model);
  const next: MarkdownTableModel = {
    header: model.header.map((cell) => ({ text: cell.text })),
    aligns: [...model.aligns],
    rows: model.rows.map((row) => row.map((cell) => ({ text: cell.text }))),
    sourceWidths: [...model.sourceWidths],
  };

  if (action === 'add-row-above' || action === 'add-row-below') {
    const base = rowIndex <= 0 ? 0 : Math.min(rowIndex - 1, next.rows.length);
    const insertAt = action === 'add-row-above' ? base : base + 1;
    next.rows.splice(insertAt, 0, createEmptyTableRow(columnCount));
    return next;
  }

  if (action === 'delete-row') {
    if (rowIndex <= 0 || next.rows.length === 0) return null;
    next.rows.splice(Math.min(rowIndex - 1, next.rows.length - 1), 1);
    return next;
  }

  if (action === 'add-column-left' || action === 'add-column-right') {
    const insertAt =
      action === 'add-column-left'
        ? Math.min(Math.max(0, columnIndex), columnCount)
        : Math.min(Math.max(0, columnIndex + 1), columnCount);
    next.header.splice(insertAt, 0, { text: '' });
    next.aligns.splice(insertAt, 0, null);
    next.sourceWidths.splice(insertAt, 0, Math.max(3, next.sourceWidths[columnIndex] ?? 8));
    for (const row of next.rows) {
      row.splice(insertAt, 0, { text: '' });
    }
    return next;
  }

  if (action === 'delete-column') {
    if (columnCount <= 2) return null;
    const removeAt = Math.min(Math.max(0, columnIndex), columnCount - 1);
    next.header.splice(removeAt, 1);
    next.aligns.splice(removeAt, 1);
    next.sourceWidths.splice(removeAt, 1);
    for (const row of next.rows) {
      row.splice(removeAt, 1);
    }
    return next;
  }

  return null;
}

function createEmptyTableRow(columnCount: number): MarkdownTableCell[] {
  return Array.from({ length: columnCount }, () => ({ text: '' }));
}

function getActiveTableCell(root: HTMLElement): { row: number; column: number } | null {
  const active = document.activeElement;
  const cell = active instanceof HTMLTableCellElement && root.contains(active) ? active : null;
  const row = Number(cell?.dataset.row ?? root.dataset.activeRow);
  const column = Number(cell?.dataset.column ?? root.dataset.activeColumn);
  if (!Number.isInteger(row) || !Number.isInteger(column)) return null;
  return { row, column };
}

function setActiveTableCell(root: HTMLElement, cell: HTMLTableCellElement): void {
  root.dataset.activeRow = cell.dataset.row;
  root.dataset.activeColumn = cell.dataset.column;
}

function getElementFromEventTarget(target: EventTarget | null): HTMLElement {
  if (target instanceof HTMLElement) return target;
  if (target instanceof Node && target.parentElement) return target.parentElement;
  return document.body;
}

function getTableCellFromTarget(
  root: HTMLElement,
  target: EventTarget | null,
): HTMLTableCellElement | null {
  const element = getElementFromEventTarget(target);
  const cell = element.closest('th, td');
  return cell instanceof HTMLTableCellElement && root.contains(cell) ? cell : null;
}

const TABLE_MENU_WIDTH = 168;
const TABLE_MENU_HEIGHT = 248;
const TABLE_MENU_GAP = 6;

function getTableMenuSize(menu: HTMLElement | null): { width: number; height: number } {
  if (!menu) return { width: TABLE_MENU_WIDTH, height: TABLE_MENU_HEIGHT };
  const rect = menu.getBoundingClientRect();
  return {
    width: rect.width > 0 ? rect.width : TABLE_MENU_WIDTH,
    height: rect.height > 0 ? rect.height : TABLE_MENU_HEIGHT,
  };
}

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function openTableContextMenu(
  root: HTMLElement,
  cell: HTMLTableCellElement,
  clientX: number,
  clientY: number,
): void {
  const menu = root.querySelector<HTMLElement>('.cm-md-table-menu');
  if (!menu) return;

  root.dataset.openMenu = 'context';
  updateTableMenuItemStates(root, cell);
  positionTableContextMenu(root, menu, clientX, clientY);
  bindTableMenuOutsideClose(root);
  window.requestAnimationFrame(() => {
    positionTableContextMenu(root, menu, clientX, clientY);
  });
}

function closeTableMenus(root: HTMLElement): void {
  delete root.dataset.openMenu;
  const cleanup = tableMenuCleanup.get(root);
  if (cleanup) {
    cleanup();
    tableMenuCleanup.delete(root);
  }
}

function bindTableMenuOutsideClose(root: HTMLElement): void {
  tableMenuCleanup.get(root)?.();

  const handlePointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (target instanceof Node && root.contains(target)) return;
    closeTableMenus(root);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeTableMenus(root);
  };

  document.addEventListener('pointerdown', handlePointerDown);
  document.addEventListener('keydown', handleKeyDown);
  tableMenuCleanup.set(root, () => {
    document.removeEventListener('pointerdown', handlePointerDown);
    document.removeEventListener('keydown', handleKeyDown);
  });
}

function positionTableContextMenu(
  root: HTMLElement,
  menu: HTMLElement,
  clientX: number,
  clientY: number,
): void {
  const rootRect = root.getBoundingClientRect();
  const menuSize = getTableMenuSize(menu);
  const left = clientX - rootRect.left + root.scrollLeft;
  const top = clientY - rootRect.top + root.scrollTop;
  const minLeft = root.scrollLeft + TABLE_MENU_GAP;
  const maxLeft =
    root.scrollLeft + window.innerWidth - rootRect.left - menuSize.width - TABLE_MENU_GAP;
  const minTop = root.scrollTop + TABLE_MENU_GAP;
  const maxTop =
    root.scrollTop + window.innerHeight - rootRect.top - menuSize.height - TABLE_MENU_GAP;

  menu.style.left = `${clamp(left, minLeft, maxLeft)}px`;
  menu.style.top = `${clamp(top, minTop, maxTop)}px`;
}

function updateTableMenuItemStates(root: HTMLElement, cell: HTMLTableCellElement): void {
  const rowIndex = Number(cell.dataset.row);
  const columnCount = cell.closest('table')?.querySelectorAll('thead th').length ?? 0;
  const disabledActions = new Set<TableAction>();

  if (!Number.isInteger(rowIndex) || rowIndex <= 0) {
    disabledActions.add('delete-row');
  }
  if (columnCount <= 2) {
    disabledActions.add('delete-column');
  }

  for (const button of root.querySelectorAll<HTMLButtonElement>('.cm-md-table-menu-item')) {
    const action = button.dataset.action as TableAction | undefined;
    button.disabled = action ? disabledActions.has(action) : false;
  }
}

function getCellText(cell: HTMLTableCellElement): string {
  return cell.dataset.sourceText ?? getCellEditingText(cell);
}

function getCellEditingText(cell: HTMLTableCellElement): string {
  const clone = cell.cloneNode(true) as HTMLTableCellElement;
  clone.querySelectorAll('.cm-md-table-resize-handle').forEach((handle) => {
    handle.remove();
  });
  return serializeCellNodes(clone);
}

function rootOrSelf(cell: HTMLTableCellElement): Element {
  return cell.closest('.cm-md-table-widget') ?? cell;
}

function renderTableCells(root: Element, active: HTMLTableCellElement | null): void {
  for (const cell of root.querySelectorAll<HTMLTableCellElement>('th, td')) {
    if (cell === active) continue;
    renderInlineMarkdown(cell, cell.dataset.sourceText ?? '');
  }
  if (active) renderActiveCell(active);
}

function renderActiveCell(cell: HTMLTableCellElement): void {
  if (isComposingTableCell(cell)) return;
  if (document.activeElement !== cell) return;
  const source = getCellText(cell);
  const selection = getCellSelectionOffsets(cell);
  renderInlineMarkdown(cell, source, selection ? [selection] : []);
  if (selection) {
    setCellSelection(
      cell,
      sourceOffsetToRenderedOffset(source, selection.from, selection ? [selection] : []),
      sourceOffsetToRenderedOffset(source, selection.to, selection ? [selection] : []),
    );
  }
}

function isComposingTableCell(cell: HTMLTableCellElement): boolean {
  return cell.dataset.composing === 'true';
}

function renderInlineMarkdown(
  cell: HTMLTableCellElement,
  source: string,
  revealRanges: Array<{ from: number; to: number }> = [],
): void {
  const handle = cell.querySelector('.cm-md-table-resize-handle');
  handle?.remove();
  cell.textContent = '';
  cell.dataset.revealRanges = serializeRevealRanges(revealRanges);

  let pos = 0;
  const pattern = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|<br\s*\/?>)/gi;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start > pos) cell.appendChild(document.createTextNode(source.slice(pos, start)));
    if (match[0].toLowerCase().startsWith('<br')) {
      cell.appendChild(document.createElement('br'));
      pos = end;
      continue;
    }
    if (shouldRevealInlineMarkdown(start, end, revealRanges)) {
      cell.appendChild(document.createTextNode(match[0]));
      pos = end;
      continue;
    }
    if (match[2] != null) {
      const strong = document.createElement('strong');
      strong.textContent = match[2];
      cell.appendChild(strong);
    } else if (match[3] != null) {
      const code = document.createElement('code');
      code.textContent = match[3];
      cell.appendChild(code);
    }
    pos = end;
  }
  if (pos < source.length) cell.appendChild(document.createTextNode(source.slice(pos)));
  if (handle) cell.appendChild(handle);
}

function shouldRevealInlineMarkdown(
  from: number,
  to: number,
  revealRanges: Array<{ from: number; to: number }>,
): boolean {
  return revealRanges.some((range) => {
    if (range.from === range.to) return range.from >= from && range.from <= to;
    return range.from < to && range.to > from;
  });
}

function toggleStrongInTableCell(cell: HTMLTableCellElement): void {
  const source = getCellText(cell);
  const selection = getCellSelectionOffsets(cell) ?? { from: source.length, to: source.length };
  const next = toggleStrongText(source, selection.from, selection.to);
  const revealRanges = [{ from: next.from, to: next.to }];
  cell.dataset.sourceText = next.text;
  renderInlineMarkdown(cell, next.text, revealRanges);
  setCellSelection(
    cell,
    sourceOffsetToRenderedOffset(next.text, next.from, revealRanges),
    sourceOffsetToRenderedOffset(next.text, next.to, revealRanges),
  );
}

function insertTableCellBreak(cell: HTMLTableCellElement): void {
  const source = getCellText(cell);
  const selection = getCellSelectionOffsets(cell) ?? { from: source.length, to: source.length };
  const nextText = `${source.slice(0, selection.from)}<br>${source.slice(selection.to)}`;
  const nextOffset = selection.from + 4;
  cell.dataset.sourceText = nextText;
  renderInlineMarkdown(cell, nextText);
  const rendered = sourceOffsetToRenderedOffset(nextText, nextOffset, []);
  setCellSelection(cell, rendered, rendered);
}

function toggleStrongText(
  text: string,
  from: number,
  to: number,
): { text: string; from: number; to: number } {
  const strong = findStrongRange(text, from, to);
  if (strong) {
    const nextText =
      text.slice(0, strong.openFrom) +
      text.slice(strong.openTo, strong.closeFrom) +
      text.slice(strong.closeTo);
    const nextFrom = Math.max(strong.openFrom, from - 2);
    const nextTo = from === to ? nextFrom : Math.max(nextFrom, to - 2);
    return { text: nextText, from: nextFrom, to: nextTo };
  }
  if (from === to) {
    const word = findStrongWordTarget(text, from);
    if (!word) {
      return {
        text: `${text.slice(0, from)}****${text.slice(from)}`,
        from: from + 2,
        to: from + 2,
      };
    }
    from = word.from;
    to = word.to;
  }
  return {
    text: `${text.slice(0, from)}**${text.slice(from, to)}**${text.slice(to)}`,
    from: from + 2,
    to: to + 2,
  };
}

function findStrongRange(
  text: string,
  from: number,
  to: number,
): { openFrom: number; openTo: number; closeFrom: number; closeTo: number } | null {
  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*/g)) {
    const start = match.index;
    if (start == null) continue;
    const openFrom = start;
    const openTo = start + 2;
    const closeFrom = start + match[0].length - 2;
    const closeTo = start + match[0].length;
    if (from === to) {
      if (from >= openTo && from <= closeFrom) return { openFrom, openTo, closeFrom, closeTo };
    } else if (from < closeTo && to > openFrom) {
      return { openFrom, openTo, closeFrom, closeTo };
    }
  }
  return null;
}

function findStrongWordTarget(text: string, pos: number): { from: number; to: number } | null {
  let local = pos;
  if (local > 0 && (local === text.length || isStrongBoundary(text[local]))) local--;
  if (local < 0 || local >= text.length || isStrongBoundary(text[local])) return null;
  let from = local;
  let to = local + 1;
  while (from > 0 && !isStrongBoundary(text[from - 1])) from--;
  while (to < text.length && !isStrongBoundary(text[to])) to++;
  return from < to ? { from, to } : null;
}

function isStrongBoundary(char: string | undefined): boolean {
  return !char || /[\s\p{P}\p{S}]/u.test(char);
}

function getCellSelectionOffsets(cell: HTMLTableCellElement): { from: number; to: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!cell.contains(range.startContainer) || !cell.contains(range.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(cell);
  before.setEnd(range.startContainer, range.startOffset);
  const selected = document.createRange();
  selected.selectNodeContents(cell);
  selected.setEnd(range.endContainer, range.endOffset);
  const source = getCellText(cell);
  const revealRanges = parseRevealRanges(cell.dataset.revealRanges);
  const from = renderedOffsetToSourceOffset(source, getRenderedOffset(before), revealRanges);
  const to = renderedOffsetToSourceOffset(source, getRenderedOffset(selected), revealRanges);
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

function setCellSelection(cell: HTMLTableCellElement, from: number, to: number): void {
  const selection = window.getSelection();
  if (!selection) return;
  const start = findRenderedPosition(cell, from);
  const end = findRenderedPosition(cell, to);
  if (!start || !end) {
    placeCaretAtEnd(cell);
    return;
  }
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaretAtEnd(cell: HTMLTableCellElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function serializeCellNodes(root: Node): string {
  let out = '';
  root.childNodes.forEach((node) => {
    if (node instanceof HTMLElement && node.classList.contains('cm-md-table-resize-handle')) {
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      return;
    }
    if (node instanceof HTMLBRElement) {
      out += '<br>';
      return;
    }
    if (node instanceof HTMLElement && node.tagName === 'STRONG') {
      out += `**${serializeCellNodes(node)}**`;
      return;
    }
    if (node instanceof HTMLElement && node.tagName === 'CODE') {
      out += `\`${node.textContent ?? ''}\``;
      return;
    }
    out += serializeCellNodes(node);
  });
  return out;
}

function serializeRevealRanges(ranges: Array<{ from: number; to: number }>): string {
  return ranges.map((range) => `${range.from}:${range.to}`).join(',');
}

function parseRevealRanges(value: string | undefined): Array<{ from: number; to: number }> {
  if (!value) return [];
  return value
    .split(',')
    .map((chunk) => {
      const [from, to] = chunk.split(':').map(Number);
      return Number.isFinite(from) && Number.isFinite(to) ? { from, to } : null;
    })
    .filter((range): range is { from: number; to: number } => range != null);
}

function getRenderedOffset(range: Range): number {
  const fragment = range.cloneContents();
  fragment.querySelectorAll?.('.cm-md-table-resize-handle').forEach((handle) => {
    handle.remove();
  });
  return getRenderedLength(fragment);
}

function getRenderedLength(root: Node): number {
  let length = 0;
  root.childNodes.forEach((node) => {
    if (node instanceof HTMLElement && node.classList.contains('cm-md-table-resize-handle')) return;
    if (node.nodeType === Node.TEXT_NODE) {
      length += node.textContent?.length ?? 0;
      return;
    }
    if (node instanceof HTMLBRElement) {
      length += 1;
      return;
    }
    length += getRenderedLength(node);
  });
  return length;
}

export function renderedOffsetToSourceOffset(
  source: string,
  renderedOffset: number,
  revealRanges: Array<{ from: number; to: number }>,
): number {
  let sourcePos = 0;
  let rendered = 0;
  const pattern = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|<br\s*\/?>)/gi;

  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start > sourcePos) {
      const textLength = start - sourcePos;
      if (renderedOffset <= rendered + textLength) {
        return sourcePos + Math.max(0, renderedOffset - rendered);
      }
      rendered += textLength;
    }

    if (match[0].toLowerCase().startsWith('<br')) {
      if (renderedOffset <= rendered) return start;
      if (renderedOffset <= rendered + 1) return end;
      rendered += 1;
      sourcePos = end;
      continue;
    }

    if (shouldRevealInlineMarkdown(start, end, revealRanges)) {
      const tokenLength = end - start;
      if (renderedOffset <= rendered + tokenLength) {
        return start + Math.max(0, renderedOffset - rendered);
      }
      rendered += tokenLength;
      sourcePos = end;
      continue;
    }

    const contentFrom = match[2] != null ? start + 2 : start + 1;
    const contentLength = match[2]?.length ?? match[3]?.length ?? 0;
    if (renderedOffset <= rendered + contentLength) {
      return contentFrom + Math.max(0, renderedOffset - rendered);
    }
    rendered += contentLength;
    sourcePos = end;
  }

  if (sourcePos < source.length && renderedOffset <= rendered + source.length - sourcePos) {
    return sourcePos + Math.max(0, renderedOffset - rendered);
  }
  return source.length;
}

export function sourceOffsetToRenderedOffset(
  source: string,
  sourceOffset: number,
  revealRanges: Array<{ from: number; to: number }>,
): number {
  let sourcePos = 0;
  let rendered = 0;
  const pattern = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|<br\s*\/?>)/gi;

  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start > sourcePos) {
      if (sourceOffset <= start) return rendered + Math.max(0, sourceOffset - sourcePos);
      rendered += start - sourcePos;
    }

    if (match[0].toLowerCase().startsWith('<br')) {
      if (sourceOffset <= start) return rendered;
      if (sourceOffset <= end) return rendered + 1;
      rendered += 1;
      sourcePos = end;
      continue;
    }

    if (shouldRevealInlineMarkdown(start, end, revealRanges)) {
      if (sourceOffset <= end) return rendered + Math.max(0, sourceOffset - start);
      rendered += end - start;
      sourcePos = end;
      continue;
    }

    const contentFrom = match[2] != null ? start + 2 : start + 1;
    const contentTo = match[2] != null ? end - 2 : end - 1;
    if (sourceOffset <= contentFrom) return rendered;
    if (sourceOffset <= contentTo) return rendered + sourceOffset - contentFrom;
    rendered += contentTo - contentFrom;
    sourcePos = end;
  }

  return rendered + Math.max(0, Math.min(sourceOffset, source.length) - sourcePos);
}

function findRenderedPosition(
  cell: HTMLTableCellElement,
  target: number,
): { node: Node; offset: number } | null {
  let rendered = 0;

  const visit = (parent: Node): { node: Node; offset: number } | null => {
    const children = Array.from(parent.childNodes);
    for (let index = 0; index < children.length; index++) {
      const node = children[index];
      if (node instanceof HTMLElement && node.classList.contains('cm-md-table-resize-handle')) {
        continue;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const length = node.textContent?.length ?? 0;
        if (target <= rendered + length) {
          return { node, offset: Math.max(0, target - rendered) };
        }
        rendered += length;
        continue;
      }
      if (node instanceof HTMLBRElement) {
        if (target <= rendered) return { node: parent, offset: index };
        if (target <= rendered + 1) return { node: parent, offset: index + 1 };
        rendered += 1;
        continue;
      }
      const found = visit(node);
      if (found) return found;
    }
    return null;
  };

  return visit(cell) ?? { node: cell, offset: cell.childNodes.length };
}

function applyColumnWidths(root: Element, widths: number[]): void {
  const total = widths.reduce((sum, width) => sum + Math.max(3, width), 0);
  root.querySelectorAll<HTMLTableColElement>('col').forEach((col, index) => {
    const width = Math.max(3, widths[index] ?? 3);
    col.style.width = `${(width / total) * 100}%`;
  });
  const table = root.querySelector<HTMLTableElement>('table');
  if (table) {
    table.style.width = '100%';
  }
}

function estimateCharacterWidth(root: Element): number {
  const probe = document.createElement('span');
  probe.textContent = '0000000000';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  root.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return width > 0 ? width : 8;
}

function focusSiblingCell(cell: HTMLTableCellElement, direction: 1 | -1): void {
  const cells = Array.from(
    cell.closest('.cm-md-table-widget')?.querySelectorAll<HTMLTableCellElement>('th, td') ?? [],
  );
  const index = cells.indexOf(cell);
  const next = cells[index + direction];
  if (!next) return;
  next.focus();
  selectCellText(next);
}

function selectCellText(cell: HTMLTableCellElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(cell);
  selection.removeAllRanges();
  selection.addRange(range);
}
