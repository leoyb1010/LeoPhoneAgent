import type { ApiClient } from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";
import { ZCODE_CLIENT_SCENES_URL } from "../providers/api/apiEndpoints.js";
import type { ClientScenesResponse, IClientScenesService } from "./clientScenes.js";

const LEO_LOCAL_ONLY: boolean = true;

export function createClientScenesService(dependencies: {
  apiClient: ApiClient;
}): IClientScenesService {
  return {
    // [leo] 自动化场景模板由官方服务器下发;不连官方,给空列表。
    list: () =>
      LEO_LOCAL_ONLY
        ? Promise.resolve({ code: 0, msg: "ok", data: [] })
        : readApiJson<ClientScenesResponse>(dependencies.apiClient, ZCODE_CLIENT_SCENES_URL, {
            method: "GET",
          }),
  };
}
