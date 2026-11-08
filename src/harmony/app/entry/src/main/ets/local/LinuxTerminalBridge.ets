import { util } from '@kit.ArkTS';

/** Only the bundled terminal page receives this bridge. It never accepts an owner or PID. */
export class LinuxTerminalBridge {
  ready: boolean = false;
  enabled: boolean = false;
  onReady: () => void = () => {};
  onInput: (text: string) => void = () => {};
  onResize: (columns: number, rows: number) => void = () => {};
  onError: (message: string) => void = () => {};

  postMessage(raw: string): void {
    if (raw.length > 8192) return;
    try {
      const event = JSON.parse(raw) as Record<string, Object>;
      const operation = `${event['op'] ?? ''}`;
      const body = (event['body'] as Record<string, Object>) ?? {};
      if (operation === 'ready') {
        this.ready = true;
        this.onReady();
        return;
      }
      if (!this.enabled || !this.ready) return;
      if (operation === 'input') {
        const text = `${body['text'] ?? ''}`;
        if (new util.TextEncoder().encodeInto(text).byteLength > 4096) throw new Error('单次终端输入超过4096字节');
        this.onInput(text);
      } else if (operation === 'resize') {
        const columns = Number(body['columns']);
        const rows = Number(body['rows']);
        if (!Number.isSafeInteger(columns) || columns < 10 || columns > 500 ||
          !Number.isSafeInteger(rows) || rows < 4 || rows > 200) return;
        this.onResize(columns, rows);
      }
    } catch (error) { this.onError(`${error}`); }
  }
}
