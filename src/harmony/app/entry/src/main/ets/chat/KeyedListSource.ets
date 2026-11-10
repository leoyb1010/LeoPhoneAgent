/**
 * LazyForEach data source for chat lists (ArkUI v1 IDataSource).
 *
 * Every row has a stable id (message identity) and a version. The LazyForEach key is
 * `id#version`, so a row is rebuilt exactly when its rendered content signature changes;
 * unchanged rows keep their built components while the list grows, shrinks or streams.
 *
 * sync() turns "old rows -> new rows" into single-step notifications applied one at a
 * time to the backing array (onDataChange / onDataDelete / onDataAdd), so the count the
 * framework sees after each notification always matches the data.
 */
export class KeyedRow<T> {
  id: string = '';
  version: number = 0;
  signature: string = '';
  value: T;
  key: string = '';

  constructor(id: string, signature: string, value: T) {
    this.id = id; this.signature = signature; this.value = value; this.key = id + '#0';
  }
}

export class KeyedListSource<T> implements IDataSource {
  private rows: KeyedRow<T>[] = [];
  private listeners: DataChangeListener[] = [];
  private nextVersion: number = 1;

  totalCount(): number { return this.rows.length; }
  getData(index: number): KeyedRow<T> { return this.rows[index]; }

  registerDataChangeListener(listener: DataChangeListener): void {
    if (this.listeners.indexOf(listener) < 0) this.listeners.push(listener);
  }
  unregisterDataChangeListener(listener: DataChangeListener): void {
    const at = this.listeners.indexOf(listener);
    if (at >= 0) this.listeners.splice(at, 1);
  }

  /** Drops everything; versions remain monotonic so no cached row key is reused. */
  reset(): void {
    this.rows = [];
    this.listeners.forEach((l: DataChangeListener) => l.onDataReloaded());
  }

  /**
   * Replace the list with `values`. `idOf` must be stable for the same message across
   * updates; `signatureOf` must cover everything the row draws. Duplicate ids get a suffix.
   */
  sync(values: T[], idOf: (value: T) => string, signatureOf: (value: T) => string): void {
    const next: KeyedRow<T>[] = [];
    const seen: Map<string, number> = new Map<string, number>();
    for (let i = 0; i < values.length; i++) {
      let id = idOf(values[i]);
      const dup = seen.get(id) ?? 0;
      seen.set(id, dup + 1);
      id = id.length + ':' + id + ':' + dup;
      next.push(new KeyedRow<T>(id, signatureOf(values[i]), values[i]));
    }
    // Common prefix by id: same message, maybe new content.
    let head = 0;
    while (head < this.rows.length && head < next.length && this.rows[head].id === next[head].id) {
      this.update(head, next[head]);
      head++;
    }
    // Common suffix by id (folding/expanding a turn changes only the middle).
    let tail = 0;
    while (tail < this.rows.length - head && tail < next.length - head &&
      this.rows[this.rows.length - 1 - tail].id === next[next.length - 1 - tail].id) {
      tail++;
    }
    const removeEnd = this.rows.length - tail;
    for (let i = removeEnd - 1; i >= head; i--) {
      this.rows.splice(i, 1);
      this.listeners.forEach((l: DataChangeListener) => l.onDataDelete(i));
    }
    const addEnd = next.length - tail;
    for (let i = head; i < addEnd; i++) {
      const row = next[i];
      // Reinsertions get a fresh key without retaining every removed message id forever.
      row.version = this.nextVersion++;
      row.key = row.id + '#' + row.version;
      this.rows.splice(i, 0, row);
      this.listeners.forEach((l: DataChangeListener) => l.onDataAdd(i));
    }
    for (let k = 0; k < tail; k++) {
      const at = next.length - tail + k;
      this.update(at, next[at]);
    }
  }

  private update(index: number, incoming: KeyedRow<T>): void {
    const current = this.rows[index];
    current.value = incoming.value;
    if (current.signature === incoming.signature) return;
    current.signature = incoming.signature;
    current.version = this.nextVersion++;
    current.key = current.id + '#' + current.version;
    this.listeners.forEach((l: DataChangeListener) => l.onDataChange(index));
  }
}
