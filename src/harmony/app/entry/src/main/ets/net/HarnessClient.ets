import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import {
  HarnessKind, harnessURL, parseHarnessKinds, parseRemoteTasks, parseSseData, RemoteTask, requireHttpsRoot, sanitizeKey
} from './Protocol';

export class ChatLine {
  role: string = 'system';
  text: string = '';
}

export class ApprovalState {
  id: string = '';
  command: string = '';
  /** Mac 给的答法(once / session / always / deny);没给时按 once / deny。 */
  choices: string[] = [];
}

/** 带状态码的请求错误:401 是中继钥匙不对,403 / 409 是 Mac 自己的答复(原因在 message 里)。 */
export class HttpError extends Error {
  code: number = 0;

  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
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
    this.base = harnessURL(requireHttpsRoot(apiRoot), machine);
    this.key = sanitizeKey(key);
  }

  async kinds(): Promise<HarnessKind[]> {
    const json = await this.getJson('/v1/capabilities');
    return parseHarnessKinds(json);
  }

  async tasks(harness: string): Promise<RemoteTask[]> {
    return parseRemoteTasks(await this.getJson('/harness/sessions'), harness);
  }

  /** 有 prompt 时桥接建好任务就直接跑这一句,不用再单独发一次。 */
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
    await this.postJson(`/harness/sessions/${encodeURIComponent(sessionId)}/send`, body);
  }

  async stop(sessionId: string): Promise<void> {
    await this.postJson(`/harness/sessions/${encodeURIComponent(sessionId)}/stop`, new EmptyJson());
  }

  async approve(sessionId: string, choice: string, approvalId: string): Promise<void> {
    if (!approvalId) {
      throw new Error('缺少审批编号');
    }
    const body = new ApprovalBody();
    body.choice = choice;
    body.approval_id = approvalId;
    await this.postJson(`/harness/sessions/${encodeURIComponent(sessionId)}/approval`, body);
  }

  /** onEnd(原因, 是否不必再连):钥匙不对、任务不在了就别再重连。 */
  startEvents(sessionId: string, after: number, onEvent: (obj: Record<string, Object>) => void,
    onEnd: (message: string, final: boolean) => void): http.HttpRequest {
    const req = http.createHttp();
    let leftover = '';
    const decoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
    const consume = (chunk: string): void => {
      leftover += chunk;
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
    };
    let finished = false;
    const fail = (message: string, final: boolean = false): void => {
      if (finished) {
        return;
      }
      finished = true;
      onEnd(message, final);
    };
    req.on('dataReceive', (chunk: ArrayBuffer) => {
      consume(decoder.decodeToString(new Uint8Array(chunk), { stream: true }));
    });
    req.on('dataEnd', () => {
      consume(decoder.decodeToString(new Uint8Array(), { stream: false }));
      if (leftover.length > 0) {
        consume('\n');
      }
    });
    req.requestInStream(`${this.base}/harness/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`, {
      method: http.RequestMethod.GET,
      header: {
        'Authorization': `Bearer ${this.key}`,
        'Accept': 'text/event-stream'
      },
      connectTimeout: 12000,
      readTimeout: 3600000
    }).then((code: number) => {
      if (code === 401) {
        fail(HarnessClient.KEY_REJECTED, true);
        return;
      }
      if (code === 403 || code === 404) {
        fail(code === 404 ? '这个任务在远程机器上已经不在了' : '远程机器拒绝了这台设备', true);
        return;
      }
      if (code < 200 || code >= 300) {
        fail(`http ${code}`);
        return;
      }
      fail('已断开');
    }).catch((err: Error) => {
      fail(err.message);
    });
    return req;
  }

  static readonly KEY_REJECTED: string = '中继钥匙不对:到「远程机器」里重新配对或换钥匙';

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
      this.throwIfBad(resp.responseCode, `${resp.result ?? ''}`);
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
          'Content-Type': 'application/json',
          // Mac 按请求编号去重:中继断线重投、手机重试都不会让同一句话跑两次(iOS 同样带)。
          'X-Leo-Request-Id': util.generateRandomUUID(false)
        },
        extraData: JSON.stringify(body),
        connectTimeout: 12000,
        // 中继最多等 Mac 60 秒;原来 20 秒就放弃,慢一点的 Mac 看起来像失败,重发又跑一遍。
        readTimeout: 65000
      });
      this.throwIfBad(resp.responseCode, `${resp.result ?? ''}`);
      if (!resp.result) {
        return new EmptyJson();
      }
      return typeof resp.result === 'string' ? JSON.parse(`${resp.result}`) as object : resp.result as object;
    } finally {
      req.destroy();
    }
  }

  /**
   * 全链路的错误体都是 `{"error":{"message": "..."}}` —— 中继(relay.py)、
   * Mac harness(leophone.routes.ts 的 jsonError)、Android 和本端 body 都一样。
   *
   * 原来只抛 `http 502`,把中继写好的「这台 Mac 当前不在线(它会自动重连,
   * 稍后再试)」整个吞掉,用户看到的是一个裸状态码。iOS(LeoAgentClient)和
   * Android(RelayFleetClient)都会把 message 抽出来,这里对齐。
   */
  static messageFrom(raw: string, code: number): string {
    try {
      const obj = JSON.parse(raw) as Record<string, Object>;
      const err = obj['error'] as Record<string, Object> | undefined;
      const nested = err ? `${err['message'] ?? ''}`.trim() : '';
      if (nested.length > 0) {
        return nested;
      }
      const flat = `${obj['message'] ?? ''}`.trim();
      if (flat.length > 0) {
        return flat;
      }
    } catch (_err) {
      // 非 JSON 响应体,退回状态码
    }
    return `http ${code}`;
  }

  /**
   * 只有 401 是中继不认钥匙。403 是 Mac 自己的答复(比如「这台设备只能拒绝这类操作」),
   * 原来也报成钥匙不对,真正的原因丢了。
   */
  private throwIfBad(code: number, raw: string = ''): void {
    if (code === 401) {
      throw new HttpError(HarnessClient.KEY_REJECTED, code);
    }
    if (code < 200 || code >= 300) {
      throw new HttpError(HarnessClient.messageFrom(raw, code), code);
    }
  }
}

export class ChatLaunch {
  static machine: string = '';
  static harness: string = 'minis';
  /** 每台机器(和 Agent)上次用的任务:再点进来接着看,不再每次新建一个空任务。 */
  static sessions: Map<string, string> = new Map();

  static key(machine: string, harness: string): string {
    return `${machine}\u0000${harness}`;
  }
}
