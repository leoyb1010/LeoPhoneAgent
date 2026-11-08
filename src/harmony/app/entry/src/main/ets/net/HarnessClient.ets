import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { RemoteAttachment, RemoteCapabilities, RemoteModel, RemoteQuestion, RemoteQuestionRequest } from '../remote/RemoteModels';
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
  private knownFeatures: RemoteCapabilities | null = null;

  constructor(apiRoot: string, machine: string, key: string) {
    this.base = harnessURL(requireHttpsRoot(apiRoot), machine);
    this.key = sanitizeKey(key);
  }

  async capabilities(): Promise<RemoteCapabilities> {
    const result = RemoteCapabilities.parse(await this.getJson('/v1/capabilities'));
    this.knownFeatures = result;
    return result;
  }

  async session(id: string): Promise<Record<string, Object>> {
    const json = await this.getJson('/harness/sessions') as Record<string, Object>;
    const sessions = json['sessions'];
    if (Array.isArray(sessions)) {
      for (const item of sessions as Object[]) {
        const row = item as Record<string, Object>;
        if (`${row['session_id'] ?? ''}` === id) { return row; }
      }
    }
    throw new HttpError('这个远程任务已经不在了', 404);
  }

  async models(): Promise<RemoteModel[]> {
    await this.requireFeature('models');
    const json = await this.getJson('/harness/models') as Record<string, Object>;
    const rows = json['models'];
    return Array.isArray(rows) ? rows.map((row: Object) => RemoteModel.parse(row))
      .filter((row: RemoteModel) => row.provider.length > 0 && row.model.length > 0) : [];
  }

  async setModel(id: string, provider: string, model: string, effort: string = ''): Promise<Object> {
    await this.requireFeature('model_switch');
    const body: Record<string, Object> = {};
    if (model) {
      await this.requireFeature('models');
      body['provider'] = provider;
      body['model'] = model;
    }
    if (effort) { await this.requireFeature('effort'); body['effort'] = effort; }
    if (Object.keys(body).length === 0) { throw new Error('请选择模型或推理强度'); }
    return await this.postJson(this.sessionPath(id) + '/model', body);
  }

  async compact(id: string): Promise<void> {
    await this.requireFeature('compact');
    await this.postJson(this.sessionPath(id) + '/compact', {});
  }

  async rename(id: string, title: string): Promise<string> {
    await this.requireFeature('rename');
    const value = title.trim().slice(0, 200);
    if (!value) { throw new Error('标题不能为空'); }
    const reply = await this.postJson(this.sessionPath(id) + '/rename', { 'title': value }) as Record<string, Object>;
    return `${reply['title'] ?? value}`;
  }

  async follow(id: string, value: boolean): Promise<boolean> {
    await this.requireFeature('follow');
    const reply = await this.postJson(this.sessionPath(id) + '/follow', { 'following': value }) as Record<string, Object>;
    return reply['following'] === true;
  }

  async answerQuestion(id: string, question: RemoteQuestionRequest, decline: boolean = false): Promise<void> {
    await this.requireFeature('ask_user_question');
    if (!question.id) { throw new Error('缺少问题编号'); }
    const body: Record<string, Object> = { 'question_id': question.id };
    if (decline) { body['decline'] = true; }
    else {
      if (question.questions.some((item: RemoteQuestion) => item.selected.length === 0 && !item.text.trim())) {
        throw new Error('请回答每个问题，或选择跳过');
      }
      body['answers'] = question.questions.map((item: RemoteQuestion) => {
        const answer: Record<string, Object> = { 'question': item.question, 'selected': item.selected };
        if (item.text.trim()) { answer['text'] = item.text.trim(); }
        return answer;
      });
    }
    await this.postJson(this.sessionPath(id) + '/answer', body);
  }

  async changes(id: string): Promise<Record<string, Object>> {
    return await this.getJson(this.sessionPath(id) + '/changes') as Record<string, Object>;
  }

  async diff(id: string, path: string, checkpoint: string = ''): Promise<string> {
    const query = '?path=' + encodeURIComponent(path) + (checkpoint ? '&checkpoint=' + encodeURIComponent(checkpoint) : '');
    const reply = await this.getJson(this.sessionPath(id) + '/diff' + query) as Record<string, Object>;
    if (reply['binary'] === true) { return '这是二进制文件'; }
    return `${reply['diff'] ?? ''}` + (reply['truncated'] === true ? '\n（改动过长，已截断）' : '');
  }

  async revert(id: string, checkpoint: string, paths: string[]): Promise<string[]> {
    if (!checkpoint && paths.length === 0) { throw new Error('请选择检查点或文件'); }
    const body: Record<string, Object> = {};
    if (checkpoint) { body['checkpoint'] = checkpoint; }
    if (paths.length > 0) { body['paths'] = paths; }
    const reply = await this.postJson(this.sessionPath(id) + '/revert', body) as Record<string, Object>;
    const reverted = reply['reverted'];
    return Array.isArray(reverted) ? reverted.map((value: Object) => `${value}`) : [];
  }

  async automations(): Promise<Record<string, Object>[]> {
    await this.requireFeature('automations');
    const result = await this.getJson('/automations') as Record<string, Object>;
    const rows = result['automations'];
    return Array.isArray(rows) ? rows as Record<string, Object>[] : [];
  }

  async createAutomation(name: string, prompt: string, cron: string): Promise<Object> {
    await this.requireFeature('automations');
    if (!prompt.trim() || !cron.trim()) { throw new Error('请填写任务和计划'); }
    const schedule: Record<string, Object> = { 'kind': 'cron', 'cron': cron.trim() };
    const body: Record<string, Object> = { 'name': name.trim(), 'prompt': prompt.trim(),
      'schedule': schedule, 'harness': 'zcode', 'mode': 'build' };
    return await this.postJson('/automations', body);
  }

  async changeAutomation(id: string, action: string, enabled: boolean = false): Promise<Object> {
    await this.requireFeature('automations');
    const path = '/automations/' + encodeURIComponent(id);
    if (action === 'run') { return await this.postJson(path + '/run', {}); }
    if (action === 'enabled') { return await this.mutateJson(path, { 'enabled': enabled }, http.RequestMethod.PATCH); }
    if (action === 'delete') { return await this.mutateJson(path, {}, http.RequestMethod.DELETE); }
    throw new Error('未知自动化操作');
  }

  async screenPreflight(): Promise<Record<string, Object>> {
    await this.requireFeature('screen_session');
    return await this.getJson('/screen/session') as Record<string, Object>;
  }
  async openScreen(offer: string, control: boolean): Promise<Record<string, Object>> {
    await this.requireFeature('screen_session');
    if (!offer || offer.length > 65536) { throw new Error('屏幕连接协商数据无效'); }
    const body: Record<string, Object> = { 'offer': offer, 'control': control, 'max_fps': 30, 'max_edge': 1920 };
    return await this.postJson('/screen/session', body) as Record<string, Object>;
  }
  async screenCandidates(id: string, candidates: Object[]): Promise<void> {
    if (!/^scr_[A-Za-z0-9-]{1,100}$/.test(id) || candidates.length > 50) { throw new Error('屏幕连接编号或候选数量无效'); }
    const body: Record<string, Object> = { 'candidates': candidates };
    await this.postJson('/screen/session/' + encodeURIComponent(id) + '/ice', body);
  }
  async closeScreen(id: string): Promise<void> {
    if (!/^scr_[A-Za-z0-9-]{1,100}$/.test(id)) { return; }
    await this.mutateJson('/screen/session/' + encodeURIComponent(id), {}, http.RequestMethod.DELETE);
  }

  async screenSnapshot(): Promise<ArrayBuffer> {
    await this.requireFeature('screen_snapshot');
    const request = http.createHttp();
    try {
      const reply = await request.request(this.base + '/screen/snapshot?max_edge=1280&q=0.65', {
        method: http.RequestMethod.GET, header: { 'Authorization': 'Bearer ' + this.key, 'Accept': 'image/jpeg' },
        expectDataType: http.HttpDataType.ARRAY_BUFFER, connectTimeout: 12000, readTimeout: 12000,
        maxRedirects: 0, usingCache: false
      });
      if (reply.responseCode !== 200) { throw new HttpError('无法读取 Mac 屏幕，请检查 Mac 上的屏幕录制权限和共享开关', reply.responseCode); }
      const bytes = reply.result as ArrayBuffer;
      if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) { throw new Error('远程屏幕图像大小无效'); }
      return bytes;
    } finally { request.destroy(); }
  }

  private sessionPath(id: string): string {
    if (!id || id.length > 200) { throw new Error('任务编号无效'); }
    return '/harness/sessions/' + encodeURIComponent(id);
  }

  private async requireFeature(feature: string): Promise<void> {
    const known = this.knownFeatures ?? await this.capabilities();
    if (!known.has(feature)) { throw new Error('这台远程机器尚未提供此能力，请更新 Mac 端'); }
  }

  async kinds(): Promise<HarnessKind[]> {
    const json = await this.getJson('/v1/capabilities');
    return parseHarnessKinds(json);
  }

  async tasks(harness: string): Promise<RemoteTask[]> {
    return parseRemoteTasks(await this.getJson('/harness/sessions'), harness);
  }

  /**
   * 有 prompt 时桥接建好任务就直接跑这一句,不用再单独发一次。
   * fullAuto:让 Mac 用全自动(免审批)跑这个任务,只对 LeoPhoneAgent 任务(zcode)有意义(iOS 同样)。
   */
  async create(harness: string, prompt: string, thinking: string, fullAuto: boolean = false): Promise<string> {
    const body: Record<string, Object> = {
      'harness': harness,
      'cwd': '~'
    };
    if (prompt.length > 0) {
      body['prompt'] = prompt;
    }
    if (thinking.length > 0) {
      body['thinking'] = thinking;
    }
    if (fullAuto) {
      body['full_auto'] = true;
    }
    const json = await this.postJson('/harness/sessions', body);
    const record = json as Record<string, Object>;
    const id = `${record['session_id'] ?? ''}`;
    if (!id) {
      throw new Error('missing session_id');
    }
    return id;
  }

  /** fullAuto:-1 不说;0 / 1 让 Mac 把这个任务切回「先问我」/ 切到全自动(接着聊的老任务也跟着开关走)。 */
  async send(sessionId: string, text: string, thinking: string, fullAuto: number = -1, attachments: RemoteAttachment[] = []): Promise<void> {
    const body: Record<string, Object> = { 'text': text };
    if (attachments.length > 0) {
      await this.requireFeature('attachments');
      body['attachments'] = attachments;
    }
    if (thinking.length > 0) {
      body['thinking'] = thinking;
    }
    if (fullAuto >= 0) {
      body['full_auto'] = fullAuto === 1;
    }
    await this.postJson(`/harness/sessions/${encodeURIComponent(sessionId)}/send`, body);
  }

  async stop(sessionId: string): Promise<void> {
    await this.postJson(`/harness/sessions/${encodeURIComponent(sessionId)}/stop`, {});
  }

  async approve(sessionId: string, choice: string, approvalId: string): Promise<void> {
    if (!approvalId) {
      throw new Error('缺少审批编号');
    }
    const body: Record<string, Object> = { 'choice': choice, 'approval_id': approvalId };
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
      connectTimeout: 12000, maxRedirects: 0, usingCache: false,
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
        connectTimeout: 12000, maxRedirects: 0, usingCache: false,
        readTimeout: 20000
      });
      this.throwIfBad(resp.responseCode, `${resp.result ?? ''}`);
      return typeof resp.result === 'string' ? JSON.parse(resp.result) as object : resp.result as object;
    } finally {
      req.destroy();
    }
  }

  private async postJson(path: string, body: Record<string, Object>): Promise<object> {
    return await this.mutateJson(path, body, http.RequestMethod.POST);
  }

  private async mutateJson(path: string, body: Record<string, Object>, method: http.RequestMethod): Promise<object> {
    const req = http.createHttp();
    try {
      const options: http.HttpRequestOptions = {
        method: method,
        header: {
          'Authorization': `Bearer ${this.key}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          // Mac 按请求编号去重:中继断线重投、手机重试都不会让同一句话跑两次(iOS 同样带)。
          'X-Leo-Request-Id': util.generateRandomUUID(false)
        },
        connectTimeout: 12000, maxRedirects: 0, usingCache: false,
        // 中继最多等 Mac 60 秒;原来 20 秒就放弃,慢一点的 Mac 看起来像失败,重发又跑一遍。
        readTimeout: 65000
      };
      if (method !== http.RequestMethod.DELETE) { options.extraData = JSON.stringify(body); }
      const resp = await req.request(this.base + path, options);
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
