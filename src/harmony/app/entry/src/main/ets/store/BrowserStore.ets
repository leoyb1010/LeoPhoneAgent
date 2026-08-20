export class BrowserTab {
  id: string = '';
  url: string = '';
  title: string = '';
}

export class BrowserStore {
  tabs: BrowserTab[] = [];
  activeId: string = '';

  active(): BrowserTab | null {
    for (let i = 0; i < this.tabs.length; i++) {
      if (this.tabs[i].id === this.activeId) {
        return this.tabs[i];
      }
    }
    return this.tabs.length > 0 ? this.tabs[0] : null;
  }

  open(url: string): BrowserTab {
    if (this.tabs.length === 0) {
      return this.add(url);
    }
    const current = this.active();
    if (current) {
      current.url = url;
      current.title = url;
      return current;
    }
    return this.add(url);
  }

  add(url: string): BrowserTab {
    if (this.tabs.length >= 3) {
      this.close(this.tabs[0].id);
    }
    const tab = new BrowserTab();
    tab.id = `t_${Date.now()}`;
    tab.url = url;
    tab.title = url;
    this.tabs = this.tabs.concat([tab]);
    this.activeId = tab.id;
    return tab;
  }

  select(id: string): BrowserTab | null {
    for (let i = 0; i < this.tabs.length; i++) {
      if (this.tabs[i].id === id) {
        this.activeId = id;
        return this.tabs[i];
      }
    }
    return null;
  }

  close(id: string): void {
    const next: BrowserTab[] = [];
    for (let i = 0; i < this.tabs.length; i++) {
      if (this.tabs[i].id !== id) {
        next.push(this.tabs[i]);
      }
    }
    this.tabs = next;
    if (this.activeId === id) {
      this.activeId = next.length > 0 ? next[0].id : '';
    }
  }

  list(): string {
    if (this.tabs.length === 0) {
      return '没有标签';
    }
    const rows: string[] = [];
    for (let i = 0; i < this.tabs.length; i++) {
      const mark = this.tabs[i].id === this.activeId ? '当前' : '后台';
      rows.push(`${this.tabs[i].id} · ${mark} · ${this.tabs[i].url}`);
    }
    return rows.join('\n');
  }
}

export const browserStore: BrowserStore = new BrowserStore();
