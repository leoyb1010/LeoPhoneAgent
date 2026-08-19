import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { HarnessKind, harnessURL, parseHarnessKinds, parseSseData, sanitizeKey } from './Protocol';

export class ChatLine {
  role: string = 'system';
  text: string = '';
}

export class ApprovalState {
  id: string = '';
  command: string = '';
}

class EmptyJson {
}

class ApprovalBody {
  choice: string = '';
  approval_id: string = '';
}

export class HarnessClient {
  private readonly base: string;
  private readonly key: string;

  constructor(apiRoot: string, machine: string, key: string) {
    this.base = harnessURL(apiRoot, machine);
    this.key = sanitizeKey(key);
  }

  async kinds(): Promise<HarnessKind[]> {
    const json = await this.getJson('/v1/capabilities');
    return parseHarnessKinds(json);
  }

  async create(harness: string, prompt: string, thinking: string): Promise<string> {
    const body: Record<string, string> = {
      'harness': harness,
      'cwd': '~'
    };
    if (prompt.length > 0) {
      body['prompt'] = prompt;
    }
    if (thinking.length > 0) {
      body['thinking'] = thinking;
    }
    const json = await this.postJson('/harness/sessions', body);
    const record = json as Record<string, Object>;
    const id = `${record['session_id'] ?? ''}`;
    if (!id) {
      throw new Error('missing session_id');
    }
    return id;
  }

  async send(sessionId: string, text: string, thinking: string): Promise<void> {
    const body: Record<string, string> = { 'text': text };
    if (thinking.length > 0) {
      body['thinking'] = thinking;
    }
    await this.postJson(`/harness/sessions/${sessionId}/send`, body);
  }

  async stop(sessionId: string): Promise<void> {
    await this.postJson(`/harness/sessions/${sessionId}/stop`, new EmptyJson());
  }

  async approve(sessionId: string, choice: string, approvalId: string): Promise<void> {
    if (!approvalId) {
      throw new Error('缺少审批编号');
    }
    const body = new ApprovalBody();
    body.choice = choice;
    body.approval_id = approvalId;
    await this.postJson(`/harness/sessions/${sessionId}/approval`, body);
  }

  startEvents(sessionId: string, after: number, onEvent: (obj: Record<string, Object>) => void,
    onError: (message: string) => void): http.HttpRequest {
    const req = http.createHttp();
    let leftover = '';
    const decoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
    req.on('dataReceive', (chunk: ArrayBuffer) => {
      leftover += decoder.decodeWithStream(new Uint8Array(chunk), { stream: true });
      const parts = leftover.split('\n');
      leftover = parts.pop() ?? '';
      for (let i = 0; i < parts.length; i++) {
        const data = parseSseData(parts[i]);
        if (!data) {
          continue;
        }
        try {
          onEvent(JSON.parse(data) as Record<string, Object>);
        } catch (_err) {
          // skip malformed frames
        }
      }
    });
    req.requestInStream(`${this.base}/harness/sessions/${sessionId}/events?after=${after}`, {
      method: http.RequestMethod.GET,
      header: {
        'Authorization': `Bearer ${this.key}`,
        'Accept': 'text/event-stream'
      },
      connectTimeout: 12000,
      readTimeout: 3600000
    }).catch((err: Error) => {
      onError(err.message);
    });
    return req;
  }

  private async getJson(path: string): Promise<object> {
    const req = http.createHttp();
    try {
      const resp = await req.request(this.base + path, {
        method: http.RequestMethod.GET,
        header: {
          'Authorization': `Bearer ${this.key}`,
          'Accept': 'application/json'
        },
        connectTimeout: 12000,
        readTimeout: 20000
      });
      this.throwIfBad(resp.responseCode);
      return typeof resp.result === 'string' ? JSON.parse(resp.result) as object : resp.result as object;
    } finally {
      req.destroy();
    }
  }

  private async postJson(path: string, body: object): Promise<object> {
    const req = http.createHttp();
    try {
      const resp = await req.request(this.base + path, {
        method: http.RequestMethod.POST,
        header: {
          'Authorization': `Bearer ${this.key}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        extraData: JSON.stringify(body),
        connectTimeout: 12000,
        readTimeout: 20000
      });
      this.throwIfBad(resp.responseCode);
      if (!resp.result) {
        return new EmptyJson();
      }
      return typeof resp.result === 'string' ? JSON.parse(`${resp.result}`) as object : resp.result as object;
    } finally {
      req.destroy();
    }
  }

  private throwIfBad(code: number): void {
    if (code === 401 || code === 403) {
      throw new Error('unauthorized');
    }
    if (code < 200 || code >= 300) {
      throw new Error(`http ${code}`);
    }
  }
}

export class ChatLaunch {
  static machine: string = '';
  static harness: string = 'minis';
}
