import { http } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import {
  LoopTurn,
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
import { providerStore } from '../store/ProviderStore';

export class StreamTurn {
  text: string = '';
  calls: ToolCall[] = [];
  promptTokens: number = 0;
  completionTokens: number = 0;
}

export class OpenAICompatClient {
  private readonly url: string;
  private readonly key: string;
  private readonly model: string;
  private readonly mode: string;
  private readonly oauth: boolean;
  private readonly account: string;

  static async open(baseUrl: string, apiKey: string, model: string, type: string,
    credential: string, instanceId: string): Promise<OpenAICompatClient> {
    let key = apiKey;
    let account = '';
    if (credential === 'oauth') {
      const fresh: OAuthToken = await OAuthSession.ensure(instanceId, apiKey, type);
      key = fresh.access;
      account = fresh.account;
      providerStore.rememberKey(instanceId, key);
    }
    return new OpenAICompatClient(baseUrl, key, model, type, credential, account);
  }

  constructor(baseUrl: string, apiKey: string, model: string, type: string, credential: string,
    account: string) {
    this.key = apiKey.trim();
    this.model = model.trim();
    this.oauth = credential === 'oauth';
    this.account = account;
    if (usesCodexResponses(type, credential, baseUrl)) {
      this.mode = 'codex';
      this.url = CODEX_RESPONSES_URL;
      return;
    }
    const root = requireProviderRoot(baseUrl);
    this.mode = providerWire(type, root);
    if (this.mode === 'anthropic') {
      this.url = anthropicMessagesUrl(root);
    } else if (this.mode === 'gemini') {
      this.url = geminiStreamUrl(root, this.model);
    } else {
      this.url = chatCompletionsUrl(root);
    }
  }

  streamTurn(turns: LoopTurn[], systemPrompt: string, thinking: string,
    onDelta: (text: string) => void, onDone: (turn: StreamTurn) => void,
    onError: (message: string) => void): http.HttpRequest {
    const req = http.createHttp();
    let leftover = '';
    let assembled = '';
    let calls: ToolCall[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    const decoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
    const consume = (chunk: string): void => {
      leftover += chunk;
      const parts = leftover.split('\n');
      leftover = parts.pop() ?? '';
      for (let i = 0; i < parts.length; i++) {
        const data = parseSseData(parts[i]);
        if (!data || data === '[DONE]') {
          continue;
        }
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
    const fail = (message: string): void => {
      if (finished) {
        return;
      }
      finished = true;
      onError(message);
    };
    const succeed = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      const turn = new StreamTurn();
      turn.text = assembled;
      turn.calls = calls;
      turn.promptTokens = promptTokens;
      turn.completionTokens = completionTokens;
      onDone(turn);
    };
    const finish = (): void => {
      if (!headersDone || !bodyDone || finished) {
        return;
      }
      if (status === 401 || status === 403) {
        fail('unauthorized');
        return;
      }
      if (status < 200 || status >= 300) {
        fail(`http ${status}`);
        return;
      }
      succeed();
    };
    req.on('dataReceive', (chunk: ArrayBuffer) => {
      consume(decoder.decodeToString(new Uint8Array(chunk), { stream: true }));
    });
    req.on('dataEnd', () => {
      consume(decoder.decodeToString(new Uint8Array(), { stream: false }));
      if (leftover.length > 0) {
        const data = leftover.trim().startsWith('data:') ? parseSseData(leftover) : leftover.trim();
        leftover = '';
        if (data && data !== '[DONE]') {
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
      extraData: this.payload(turns, systemPrompt, thinking),
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
      usingCache: false,
      connectTimeout: 120000,
      readTimeout: 3600000
    }).then((code: number) => {
      status = code;
      headersDone = true;
      if (code < 200 || code >= 300) {
        fail(code === 401 || code === 403 ? 'unauthorized' : `http ${code}`);
        return;
      }
      finish();
    }).catch((err: Error) => {
      fail(err.message);
    });
    return req;
  }

  private readDelta(obj: object): string {
    if (this.mode === 'codex') {
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
    if (this.mode === 'codex') {
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
    if (this.mode === 'anthropic') {
      if (this.oauth) {
        return {
          'Authorization': `Bearer ${this.key}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
          'Accept': 'text/event-stream',
          'Content-Type': 'application/json'
        };
      }
      return {
        'x-api-key': this.key,
        'anthropic-version': '2023-06-01',
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json'
      };
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

  private payload(turns: LoopTurn[], systemPrompt: string, thinking: string): string {
    if (this.mode === 'codex') {
      return responsesBodyJson(this.model, systemPrompt, turns, thinking);
    }
    if (this.mode === 'anthropic') {
      return `{"model":${JSON.stringify(this.model)},"max_tokens":8192,"stream":true,"system":${JSON.stringify(systemPrompt)},"messages":${anthropicMessagesJson(turns)},"tools":${anthropicToolSchemaJson()}}`;
    }
    if (this.mode === 'gemini') {
      return `{"system_instruction":{"parts":[{"text":${JSON.stringify(systemPrompt)}}]},"contents":${geminiContentsJson(turns)},"tools":${geminiToolSchemaJson()}}`;
    }
    const effort = thinking.length > 0 ? `,"reasoning_effort":${JSON.stringify(thinking)}` : '';
    return `{"model":${JSON.stringify(this.model)},"stream":true,"messages":${wireMessagesJson(turns, systemPrompt)},"tools":${localToolSchemaJson()}${effort}}`;
  }
}
