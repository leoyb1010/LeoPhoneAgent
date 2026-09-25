import { ReleaseCatalog } from '../release/ReleaseCatalog';
import { normalizeApiRoot } from './Protocol';

export class AgentFrame {
  type: string = '';
  id: string = '';
  method: string = 'GET';
  path: string = '/';
  body: string = '';
  /** 中继转来的请求编号:同一个 POST 因断线重投时,按它认出来,不再执行第二遍。 */
  requestId: string = '';
}

export function agentWsUrl(apiBase: string): string {
  let url = normalizeApiRoot(apiBase);
  url = url.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  url = url.replace(/\/relay\/api$/i, '/relay/agent');
  if (!/\/relay\/agent$/i.test(url)) {
    url = /\/relay$/i.test(url) ? `${url}/agent` : `${url}/relay/agent`;
  }
  return url;
}

export function registerJson(name: string, key: string): string {
  return `{"type":"register","name":${JSON.stringify(name)},"key":${JSON.stringify(key)},"info":{"platform":"harmony","server":"minis","version":${JSON.stringify(ReleaseCatalog.currentVersion)}}}`;
}

export function parseAgentFrame(raw: string): AgentFrame | null {
  try {
    const obj = JSON.parse(raw) as Record<string, Object>;
    const type = `${obj['type'] ?? ''}`;
    if (!type) {
      return null;
    }
    const frame = new AgentFrame();
    frame.type = type;
    frame.id = `${obj['id'] ?? ''}`;
    frame.method = `${obj['method'] ?? 'GET'}`;
    frame.path = `${obj['path'] ?? '/'}`;
    frame.requestId = `${obj['request_id'] ?? ''}`;
    const body = obj['body'];
    frame.body = body === undefined || body === null ? '' : JSON.stringify(body);
    return frame;
  } catch (_err) {
    return null;
  }
}

export function respJson(id: string, status: number, body: string): string {
  return `{"type":"resp","id":${JSON.stringify(id)},"status":${status},"body":${body}}`;
}

export function streamDataJson(id: string, data: string): string {
  return `{"type":"stream_data","id":${JSON.stringify(id)},"data":${JSON.stringify(data)}}`;
}

/** 流上的保活:中继把它转成 SSE 注释行,长时间没输出时控制端和代理不会断开(Mac、安卓每 25 秒一条)。 */
export function streamKeepaliveJson(id: string): string {
  return `{"type":"stream_keepalive","id":${JSON.stringify(id)}}`;
}

export function streamCloseJson(id: string): string {
  return `{"type":"stream_close","id":${JSON.stringify(id)}}`;
}

export function eventJson(machine: string, event: string): string {
  return `{"type":"event","machine":${JSON.stringify(machine)},"event":${event}}`;
}

export function errorBody(message: string): string {
  return `{"error":{"message":${JSON.stringify(message)}}}`;
}
