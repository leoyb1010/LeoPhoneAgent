// [leo] vitest 接入测试 HOME 隔离：globalSetup 在主进程先建好临时 HOME（worker 继承），
// setupFiles 在每个 worker 加载用例前再落一次并装写入守卫。见 ./home.mjs。
import { fileURLToPath } from "node:url";

export const leoTestHomeSetupFile = fileURLToPath(new URL("./home.mjs", import.meta.url));
export const leoTestHomeGlobalSetup = fileURLToPath(new URL("./vitest-global-setup.mjs", import.meta.url));

export function leoTestIsolation() {
  return { setupFiles: [leoTestHomeSetupFile], globalSetup: [leoTestHomeGlobalSetup] };
}
