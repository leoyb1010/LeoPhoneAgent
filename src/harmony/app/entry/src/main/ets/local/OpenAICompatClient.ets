import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import {
  LoopTurn,
  turnImages,
  ChatImage,
  ToolCall,
  anthropicDeltaFromJson,
  anthropicMessagesJson,
  anthropicMessagesUrl,
  anthropicToolSchemaJson,
  applyAnthropicToolDelta,
  applyGeminiToolDelta,
  applyResponsesToolDelta,
  applyToolDelta,
  chatCompletionsUrl,
  CODEX_CLIENT_VERSION,
  CODEX_RESPONSES_URL,
  geminiContentsJson,
  geminiDeltaFromJson,
  geminiStreamUrl,
  geminiToolSchemaJson,
  localToolSchemaJson,
  openAiDeltaFromJson,
  openAiErrorFromJson,
  parseSseData,
  providerWire,
  requireProviderRoot,
  responsesBodyJson,
  responsesDeltaFromJson,
  responsesErrorFromJson,
  usageFromJson,
  usesCodexResponses,
  wireMessagesJson
} from './LocalProtocol';
import { OAuthSession, OAuthToken } from './OAuthSession';
import { GeneratedMedia, GeneratedImageCandidate } from './GeneratedMedia';
import { modelImageMode, openCodeWire } from './ProviderModels';
import { CODEX_MODELS_URL, codexCatalogIds } from './ProviderModels';
import { providerStore } from '../store/ProviderStore';
import { kindByKey } from './ProviderCatalog';

export class StreamTurn {
  text: string = '';
  calls: ToolCall[] = [];
  images: GeneratedImageCandidate[] = [];
  promptTokens: number = 0;
  completionTokens: number = 0;
}

export class OpenAICompatClient {
  private readonly url: string;
  private readonly key: string;
  private readonly model: string;
  private readonly mode: string;
  private readonly account: string;
  private readonly imageMode: string;
  private readonly root: string;
  private readonly providerType: string;
  // OpenCode Go 不带会话 id 的请求一律 400 MissingSessionID;同一个对话用同一个 id,方便它路由和缓存。
  private readonly session: string;

  static async open(baseUrl: string, apiKey: string, model: string, type: string,
    credential: string, instanceId: string, session: string = '', expectedReference: string = '', metadata: string = ''): Promise<OpenAICompatClient> {
    let key = apiKey;
    let account = '';
    if (credential === 'oauth' && type === 'anthropic') {
      throw new Error('Claude 订阅登录已下线(Anthropic 不允许第三方应用用订阅账号调用)。请到「AI 服务商」里把这一家改成 Anthropic 控制台的 API Key;要用订阅,可以远控 Mac 上你自己登录的官方 claude。');
    }
    if (credential === 'oauth') {
      const fresh: OAuthToken = await OAuthSession.ensure(instanceId, apiKey, type, expectedReference);
      key = fresh.access;
      account = fresh.account;
    }
    // 订阅登录拿到的令牌只发给这家官方地址,不跟着自填的 API 根走。
    const root = credential === 'oauth' ? kindByKey(type).root : baseUrl;
    return new OpenAICompatClient(root, key, model, type, credential, account, session, metadata);
  }

  /** ChatGPT 登录的模型目录(和 Codex CLI 同一份)。拉不到就抛错,调用方保留原来的列表。 */
  static async codexModels(instanceId: string): Promise<string[]> {
    const fresh: OAuthToken = await OAuthSession.ensure(instanceId, providerStore.keyFor(instanceId), 'openAI');
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${fresh.access}`,
      'Version': CODEX_CLIENT_VERSION,
      'User-Agent': `codex_cli_rs/${CODEX_CLIENT_VERSION} (Linux; arm64)`,
      'Originator': 'codex_cli_rs',
      'Accept': 'application/json'
    };
    if (fresh.account.length > 0) {
      headers['Chatgpt-Account-Id'] = fresh.account;
    }
    const req = http.createHttp();
    try {
      const resp = await req.request(`${CODEX_MODELS_URL}?client_version=${CODEX_CLIENT_VERSION}`, {
        method: http.RequestMethod.GET,
        header: headers,
        connectTimeout: 20000,
        readTimeout: 20000
      });
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error(`http ${resp.responseCode}`);
      }
      const ids = codexCatalogIds(typeof resp.result === 'string' ? JSON.parse(resp.result) as object :
        resp.result as object);
      if (ids.length === 0) {
        throw new Error('目录是空的');
      }
      return ids;
    } finally {
      req.destroy();
    }
  }

  constructor(baseUrl: string, apiKey: string, model: string, type: string, credential: string,
    account: string, session: string = '', metadata: string = '') {
    this.key = apiKey.trim();
    this.model = model.trim();
    this.account = account; this.providerType = type; this.imageMode = modelImageMode(model, metadata, type); this.root = requireProviderRoot(baseUrl);
    this.session = session.length > 0 ? session : util.generateRandomUUID(false);
    if (usesCodexResponses(type, credential, baseUrl)) {
      this.mode = 'codex';
      this.url = CODEX_RESPONSES_URL;
      return;
    }
    const root = requireProviderRoot(baseUrl);
    this.mode = type === 'openCodeGo' ? openCodeWire(this.model, metadata) : providerWire(type, root);
    if (this.mode === 'responses') { this.url = root + '/responses';
    } else if (this.mode === 'anthropic') {
      this.url = anthropicMessagesUrl(root);
    } else if (this.mode === 'gemini') {
      this.url = geminiStreamUrl(root, this.model);
    } else {
      this.url = chatCompletionsUrl(root);
    }
  }

  /** withTools=false:写摘要、起标题这类只要文字的请求,不带工具。 */
  streamTurn(turns: LoopTurn[], systemPrompt: string, thinking: string,
    onDelta: (text: string) => void, onDone: (turn: StreamTurn) => void,
    onError: (message: string) => void, withTools: boolean = true, includeMemory: boolean = true, isCurrent: () => boolean = () => true): http.HttpRequest {
    const req = http.createHttp();
    if (this.imageMode === 'images') {
      this.imageTurn(req, turns, onDone, onError, isCurrent); return req;
    }
    let media: GeneratedImageCandidate[] = [];
    let leftover = '';
    let assembled = '';
    let calls: ToolCall[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    // Anthropic 的一轮以 message_delta(带 stop_reason)/ message_stop 收尾;没见到就是中途断了。
    let ended = false;
    const decoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
    const noteEnd = (obj: object): void => {
      const type = `${(obj as Record<string, Object>)['type'] ?? ''}`;
      if (type === 'message_delta' || type === 'message_stop') {
        ended = true;
      }
    };
    const collectMedia = (raw: string): void => {
      try {
        const candidates = GeneratedMedia.parseEvent(raw);
        for (const candidate of candidates) {
          if (!candidate.final) continue;
          const previous = media.findIndex((item: GeneratedImageCandidate) => candidate.sourceId ? item.sourceId === candidate.sourceId : item.base64 === candidate.base64 && item.url === candidate.url);
          if (previous >= 0) media[previous] = candidate; else media.push(candidate);
          if (media.length > 16) { fail('单次生成图片超过16张'); return; }
        }
      } catch (_error) { fail('生成图片响应格式或大小不受支持'); }
    };
    const consume = (chunk: string): void => {
      if (finished || pendingError) return;
      leftover += chunk;
      const parts = leftover.split('\n');
      leftover = parts.pop() ?? '';
      for (let i = 0; i < parts.length; i++) {
        const data = parseSseData(parts[i]);
        if (!data || data === '[DONE]') {
          continue;
        }
        collectMedia(data);
        if (finished || pendingError) return;
        try {
          const obj = JSON.parse(data) as object;
          const failed = responsesErrorFromJson(obj);
          if (failed.length > 0) {
            fail(failed);
            return;
          }
          const used = usageFromJson(obj);
          if (used[0] > 0 || used[1] > 0) {
            promptTokens = used[0];
            completionTokens = used[1];
          }
          noteEnd(obj);
          const delta = this.readDelta(obj);
          if (delta.length > 0) {
            assembled += delta;
            onDelta(delta);
          }
          calls = this.readCalls(calls, obj);
        } catch (_err) {
          // skip malformed frames
        }
      }
    };
    let finished = false;
    let status = 0;
    let headersDone = false;
    let bodyDone = false;
    let pendingError = '';
    const fail = (message: string): void => {
      if (finished) {
        return;
      }
      if (!headersDone) { pendingError = message; return; }
      finished = true;
      const detail = status > 0 && (status < 200 || status >= 300) && !/^http \d/.test(message) ? `http ${status}: ${message}` : message;
      onError(detail);
    };
    const succeed = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      const turn = new StreamTurn();
      turn.text = assembled;
      turn.calls = calls; turn.images = media;
      turn.promptTokens = promptTokens;
      turn.completionTokens = completionTokens;
      onDone(turn);
    };
    const finish = (): void => {
      if (!headersDone || !bodyDone || finished) {
        return;
      }
      if (pendingError) { fail(pendingError); return; }
      if (status === 401 || status === 403) {
        fail('unauthorized');
        return;
      }
      if (status < 200 || status >= 300) {
        fail(`http ${status}`);
        return;
      }
      if (this.mode === 'anthropic' && !ended) {
        fail('stream ended early');
        return;
      }
      succeed();
    };
    req.on('dataReceive', (chunk: ArrayBuffer) => {
      consume(decoder.decodeToString(new Uint8Array(chunk), { stream: true }));
    });
    req.on('dataEnd', () => {
      if (finished) return;
      consume(decoder.decodeToString(new Uint8Array(), { stream: false }));
      if (leftover.length > 0 && !pendingError) {
        const data = leftover.trim().startsWith('data:') ? parseSseData(leftover) : leftover.trim();
        leftover = '';
        if (data && data !== '[DONE]') {
          collectMedia(data);
          if (finished || pendingError) { bodyDone = true; finish(); return; }
          try {
            const obj = JSON.parse(data) as object;
            const failed = responsesErrorFromJson(obj);
            if (failed.length > 0) {
              fail(failed);
              return;
            }
            const err = openAiErrorFromJson(obj);
            if (err.length > 0 && assembled.length === 0 && calls.length === 0) {
              fail(err);
              return;
            }
            noteEnd(obj);
            const extra = this.readDelta(obj);
            if (extra.length > 0) {
              assembled += extra;
              onDelta(extra);
            }
            calls = this.readCalls(calls, obj);
          } catch (_err) {
            // ignore leftover that is not JSON
          }
        }
      }
      bodyDone = true;
      finish();
    });
    req.requestInStream(this.url, {
      method: http.RequestMethod.POST,
      header: this.headers(),
      extraData: this.payload(turns, systemPrompt, thinking, withTools, includeMemory),
      maxRedirects: 0,
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
      usingCache: false,
      connectTimeout: 120000,
      readTimeout: 3600000
    }).then((code: number) => {
      status = code;
      headersDone = true;
      if (code < 200 || code >= 300) {
        fail(pendingError || (code === 401 || code === 403 ? 'unauthorized' : `http ${code}`));
        return;
      }
      if (pendingError) { fail(pendingError); return; }
      finish();
    }).catch((err: Error) => {
      headersDone = true; fail(pendingError || err.message);
    });
    return req;
  }

  private async imageTurn(request: http.HttpRequest, turns: LoopTurn[], onDone: (turn: StreamTurn) => void,
    onError: (message: string) => void, isCurrent: () => boolean): Promise<void> {
    try {
      const references = this.imageReferences(turns); const boundary = 'leobot-' + util.generateRandomUUID(false);
      const address = this.root + (references.length ? '/images/edits' : '/images/generations');
      const headers = this.headers(); headers['Accept'] = 'application/json';
      if (references.length) headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!isCurrent()) return;
        const body = references.length ? this.imageEditBody(turns, references, boundary, attempt === 0) :
          `{"model":${JSON.stringify(this.model)},"prompt":${JSON.stringify(this.imagePrompt(turns))},"n":1${attempt === 0 ? ',"response_format":"b64_json"' : ''}}`;
        const response = await request.request(address, { method: http.RequestMethod.POST, header: headers, extraData: body,
          expectDataType: http.HttpDataType.ARRAY_BUFFER, maxLimit: 64 * 1024 * 1024, maxRedirects: 0,
          usingCache: false, connectTimeout: 120000, readTimeout: 600000 });
        if (!isCurrent()) return;
        const raw = typeof response.result === 'string' ? response.result :
          util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(new Uint8Array(response.result as ArrayBuffer));
        if (raw.length > 64 * 1024 * 1024) throw new Error('生成图片响应超过64MiB');
        if (response.responseCode < 200 || response.responseCode >= 300) {
          if (attempt === 0 && response.responseCode === 400 && /response_format|b64_json/i.test(raw)) continue;
          throw new Error(response.responseCode === 401 || response.responseCode === 403 ? 'unauthorized' : 'http ' + response.responseCode);
        }
        const media = GeneratedMedia.parseEvent(raw).filter((item: GeneratedImageCandidate) => item.final);
        if (!media.length || media.length > 16) throw new Error('服务商没有返回有效图片或超过16张上限');
        const turn = new StreamTurn(); turn.images = media; onDone(turn); return;
      }
    } catch (error) { if (isCurrent()) onError(error instanceof Error ? error.message : '生成图片请求失败'); }
    finally { request.destroy(); }
  }

  private imagePrompt(turns: LoopTurn[]): string {
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'user') return turns[i].content;
    return '';
  }
  private imageReferences(turns: LoopTurn[]): ChatImage[] {
    // A new attachment replaces the previous reference set. Otherwise the latest generated result can be edited.
    for (let i = turns.length - 1; i >= 0; i--) { const images = turnImages(turns[i]); if (images.length) return images; }
    return [];
  }
  private imageEditBody(turns: LoopTurn[], images: ChatImage[], boundary: string, responseFormat: boolean = true): ArrayBuffer {
    const encoder = new util.TextEncoder(); const chunks: Uint8Array[] = [];
    const field = (name: string, value: string): void => { chunks.push(encoder.encodeInto('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n')); };
    field('model', this.model); field('prompt', this.imagePrompt(turns)); field('n', '1'); if (responseFormat) field('response_format', 'b64_json');
    for (let i = 0; i < images.length; i++) {
      const mime = images[i].mime === 'image/png' ? 'image/png' : 'image/jpeg';
      const bytes = new util.Base64Helper().decodeSync(images[i].b64);
      if (bytes.length > 8 * 1024 * 1024) throw new Error('参考图片超过8MiB');
      chunks.push(encoder.encodeInto('--' + boundary + '\r\nContent-Disposition: form-data; name="' + (i === 0 ? 'image' : 'image[]') + '"; filename="image' + i + (mime === 'image/png' ? '.png' : '.jpg') + '"\r\nContent-Type: ' + mime + '\r\n\r\n'));
      chunks.push(bytes); chunks.push(encoder.encodeInto('\r\n'));
    }
    chunks.push(encoder.encodeInto('--' + boundary + '--\r\n'));
    let total = 0; for (const chunk of chunks) total += chunk.length;
    if (total > 64 * 1024 * 1024) throw new Error('参考图片总大小超过64MiB');
    const output = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output.buffer;
  }

  private readDelta(obj: object): string {
    if (this.mode === 'codex' || this.mode === 'responses') {
      return responsesDeltaFromJson(obj);
    }
    if (this.mode === 'anthropic') {
      return anthropicDeltaFromJson(obj);
    }
    if (this.mode === 'gemini') {
      return geminiDeltaFromJson(obj);
    }
    return openAiDeltaFromJson(obj);
  }

  private readCalls(acc: ToolCall[], obj: object): ToolCall[] {
    if (this.mode === 'codex' || this.mode === 'responses') {
      return applyResponsesToolDelta(acc, obj);
    }
    if (this.mode === 'anthropic') {
      return applyAnthropicToolDelta(acc, obj);
    }
    if (this.mode === 'gemini') {
      return applyGeminiToolDelta(acc, obj);
    }
    return applyToolDelta(acc, obj);
  }

  private headers(): Record<string, string> {
    const headers = this.baseHeaders();
    if (this.providerType === 'openCodeGo' || this.url.startsWith('https://opencode.ai/')) {
      headers['x-opencode-session'] = this.session;
    }
    return headers;
  }

  private baseHeaders(): Record<string, string> {
    if (this.mode === 'anthropic') {
      const headers: Record<string, string> = {
        'x-api-key': this.key,
        'anthropic-version': '2023-06-01',
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json'
      };
      if (this.providerType === 'openCodeGo') headers['Authorization'] = 'Bearer ' + this.key;
      return headers;
    }
    if (this.mode === 'gemini') {
      return {
        'x-goog-api-key': this.key,
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json'
      };
    }
    if (this.mode === 'codex') {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.key}`,
        'Version': CODEX_CLIENT_VERSION,
        'Openai-Beta': 'responses=experimental',
        'User-Agent': `codex_cli_rs/${CODEX_CLIENT_VERSION} (Linux; arm64)`,
        'Originator': 'codex_cli_rs',
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json'
      };
      if (this.account.length > 0) {
        headers['Chatgpt-Account-Id'] = this.account;
      }
      return headers;
    }
    return {
      'Authorization': `Bearer ${this.key}`,
      'Accept': 'text/event-stream',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no'
    };
  }

  private payload(turns: LoopTurn[], systemPrompt: string, thinking: string, withTools: boolean, includeMemory: boolean = true): string {
    if (this.imageMode === 'images') return `{"model":${JSON.stringify(this.model)},"prompt":${JSON.stringify(this.imagePrompt(turns))},"n":1,"response_format":"b64_json"}`;
    if (this.mode === 'responses') {
      const source = JSON.parse(responsesBodyJson(this.model, systemPrompt, turns, thinking, withTools, includeMemory)) as Record<string, Object>;
      const body: Record<string, Object> = {};
      for (const key of Object.keys(source)) if (key !== 'include' && key !== 'prompt_cache_key') body[key] = source[key];
      return JSON.stringify(body);
    }
    if (this.mode === 'codex') {
      const body = JSON.parse(responsesBodyJson(this.model, systemPrompt, turns, thinking, withTools, includeMemory)) as Record<string, Object>;
      if (withTools) { const tools = (body['tools'] ?? []) as Object[]; const generator: Record<string, Object> = { 'type': 'image_generation', 'output_format': 'png' }; body['tools'] = tools.concat([generator]); }
      return JSON.stringify(body);
    }
    if (this.mode === 'anthropic') {
      const tools = withTools ? `,"tools":${anthropicToolSchemaJson(includeMemory)}` : '';
      return `{"model":${JSON.stringify(this.model)},"max_tokens":8192,"stream":true,"system":${JSON.stringify(systemPrompt)},"messages":${anthropicMessagesJson(turns)}${tools}}`;
    }
    if (this.mode === 'gemini') {
      const tools = withTools && !this.imageMode ? `,"tools":${geminiToolSchemaJson(includeMemory)}` : '';
      const generation = this.imageMode && withTools ? ',"generationConfig":{"responseModalities":["TEXT","IMAGE"]}' : '';
      return `{"system_instruction":{"parts":[{"text":${JSON.stringify(systemPrompt)}}]},"contents":${geminiContentsJson(turns)}${tools}${generation}}`;
    }
    const modalities = this.imageMode === 'multimodal' && withTools ? ',"modalities":["text","image"]' : '';
    const effort = thinking.length > 0 ? `,"reasoning_effort":${JSON.stringify(thinking)}` : '';
    const tools = withTools ? `,"tools":${localToolSchemaJson(includeMemory)}` : '';
    return `{"model":${JSON.stringify(this.model)},"stream":true,"messages":${wireMessagesJson(turns, systemPrompt)}${tools}${effort}${modalities}}`;
  }
}
