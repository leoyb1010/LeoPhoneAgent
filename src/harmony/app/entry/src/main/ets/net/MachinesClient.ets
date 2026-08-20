import { http } from '@kit.NetworkKit';
import {
  DEFAULT_API_ROOT,
  RelayDiscoveredMachine,
  parseMachines,
  requireHttpsRoot,
  sanitizeKey
} from './Protocol';

export class MachinesClient {
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
