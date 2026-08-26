import { http } from '@kit.NetworkKit';
import {
  DEFAULT_API_ROOT,
  RelayDiscoveredMachine,
  parseMachines,
  requireHttpsRoot,
  sanitizeKey
} from './Protocol';

export class JoinResult {
  accessKey: string = '';
  machine: string = '';
}

export class MachinesClient {
  static async join(apiRoot: string, token: string): Promise<JoinResult> {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      throw new Error('短码不能为空');
    }
    const root = requireHttpsRoot(apiRoot.length > 0 ? apiRoot : DEFAULT_API_ROOT);
    const url = root + '/join';
    const req = http.createHttp();
    try {
      const resp = await req.request(url, {
        method: http.RequestMethod.POST,
        header: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        extraData: JSON.stringify({ 'token': trimmed }),
        connectTimeout: 12000,
        readTimeout: 12000
      });
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error('短码已过期或无效');
      }
      const body = typeof resp.result === 'string' ? JSON.parse(resp.result) as Record<string, Object> : resp.result as Record<string, Object>;
      const out = new JoinResult();
      out.accessKey = `${body['accessKey'] ?? ''}`;
      out.machine = `${body['machine'] ?? ''}`;
      if (out.accessKey.length < 16) {
        throw new Error('中继没有返回设备钥匙');
      }
      return out;
    } finally {
      req.destroy();
    }
  }

  static async list(apiRoot: string, key: string): Promise<RelayDiscoveredMachine[]> {
    const trimmed = sanitizeKey(key);
    if (trimmed.length < 16) {
      throw new Error('unauthorized');
    }
    const root = requireHttpsRoot(apiRoot.length > 0 ? apiRoot : DEFAULT_API_ROOT);
    const url = root + '/machines';
    const req = http.createHttp();
    try {
      const resp = await req.request(url, {
        method: http.RequestMethod.GET,
        header: {
          'Authorization': `Bearer ${trimmed}`,
          'Accept': 'application/json'
        },
        connectTimeout: 12000,
        readTimeout: 12000
      });
      if (resp.responseCode === 401 || resp.responseCode === 403) {
        throw new Error('unauthorized');
      }
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error(`http ${resp.responseCode}`);
      }
      const body = typeof resp.result === 'string' ? JSON.parse(resp.result) as object : resp.result as object;
      return parseMachines(body);
    } finally {
      req.destroy();
    }
  }
}
