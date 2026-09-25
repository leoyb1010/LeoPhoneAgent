import { http } from '@kit.NetworkKit';
import { HarnessClient } from './HarnessClient';
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
  /** Mac 1.2 出的码要等 Mac 点允许:这两项用来轮询结果。 */
  pendingId: string = '';
  pollSecret: string = '';
}

export class MachinesClient {
  static async join(apiRoot: string, token: string, name: string = ''): Promise<JoinResult> {
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
        // name 让 Mac 的设备列表认得出这台是谁(原来一律显示「旧版设备」)。
        extraData: JSON.stringify({ 'token': trimmed, 'name': name }),
        connectTimeout: 12000,
        readTimeout: 12000
      });
      const raw = `${resp.result ?? ''}`;
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        // 过期、用过、太频繁:用中继给的原因(原来一律说「短码已过期」)。
        throw new Error(HarnessClient.messageFrom(raw, resp.responseCode));
      }
      const body = typeof resp.result === 'string' ? JSON.parse(resp.result) as Record<string, Object> : resp.result as Record<string, Object>;
      const out = new JoinResult();
      out.accessKey = `${body['accessKey'] ?? ''}`;
      out.machine = `${body['machine'] ?? ''}`;
      if (resp.responseCode === 202) {
        out.pendingId = `${body['pendingId'] ?? ''}`;
        out.pollSecret = `${body['pollSecret'] ?? ''}`;
        return out;
      }
      if (out.accessKey.length < 16) {
        throw new Error('中继没有返回设备钥匙');
      }
      return out;
    } finally {
      req.destroy();
    }
  }

  /** 等 Mac 批准的配对:批准了返回钥匙,还在等返回 '',被拒或过期抛错。 */
  static async joinStatus(apiRoot: string, pendingId: string, secret: string): Promise<string> {
    const root = requireHttpsRoot(apiRoot.length > 0 ? apiRoot : DEFAULT_API_ROOT);
    const req = http.createHttp();
    try {
      const resp = await req.request(`${root}/join/${encodeURIComponent(pendingId)}?secret=${encodeURIComponent(secret)}`, {
        method: http.RequestMethod.GET,
        header: { 'Accept': 'application/json' },
        connectTimeout: 12000,
        readTimeout: 12000
      });
      if (resp.responseCode === 404) {
        throw new Error('这次配对请求已经不在了,请让 Mac 重新出码');
      }
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        return '';
      }
      const body = typeof resp.result === 'string' ? JSON.parse(resp.result) as Record<string, Object> : resp.result as Record<string, Object>;
      const status = `${body['status'] ?? ''}`;
      if (status === 'approved') {
        return `${body['accessKey'] ?? ''}`;
      }
      if (status === 'denied') {
        throw new Error('Mac 上拒绝了这次配对');
      }
      if (status === 'expired') {
        throw new Error('等太久过期了,请让 Mac 重新出码');
      }
      return '';
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
