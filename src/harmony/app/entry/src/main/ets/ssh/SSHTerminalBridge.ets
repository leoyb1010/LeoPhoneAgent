import { SSHRuntime } from '../local/SSHRuntime';

/** Bundled renderer has only input/resize access to its own connected terminal. */
export class SSHTerminalBridge {
  owner: string = '';
  ready: boolean = false;
  enabled: boolean = false;
  onError: (text: string) => void = () => {};
  postMessage(raw: string): void {
    if (raw.length > 32768) { return; }
    try {
      const value = JSON.parse(raw) as Record<string, Object>;
      const body = value['body'] as Record<string, Object>;
      if (value['op'] === 'ready') { this.ready = true; return; }
      if (!this.enabled || !this.owner) { return; }
      if (value['op'] === 'input') { SSHRuntime.write(this.owner, `${body['text'] ?? ''}`); }
      if (value['op'] === 'resize') { SSHRuntime.resize(this.owner, Number(body['columns']), Number(body['rows'])); }
    } catch (_err) { this.onError('终端输入暂未送达，请检查连接后重试'); }
  }
}
