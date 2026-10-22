import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * [leo] 用户主动退出的标记。宿主 Mac 上的常驻守护(scripts/fleet/com.leoyuan.leobot-keepalive.plist)
 * 每 2 分钟看一眼 LeoBot 在不在跑,以前不分青红皂白都拉起 —— 用户自己退出也会被拉回来。
 * 现在正常退出(before-quit)写这个标记,守护看到就不拉;崩溃不会写,照样拉起。下次启动清掉。
 */
export const LEO_QUIT_INTENT_FILE = join(
  process.env["LEOAGENT_HOME"]?.trim() || join(homedir(), ".leoagent"),
  "leobot-user-quit",
);

export function markLeoQuitIntent(reason: string): void {
  try {
    mkdirSync(dirname(LEO_QUIT_INTENT_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(LEO_QUIT_INTENT_FILE, `${new Date().toISOString()} ${reason}\n`, { mode: 0o600 });
  } catch {
    // 写不了就退化成以前的行为(守护会拉起),不能挡住退出
  }
}

export function clearLeoQuitIntent(): void {
  try {
    rmSync(LEO_QUIT_INTENT_FILE, { force: true });
  } catch {
    // 删不掉只影响守护是否拉起,不影响启动
  }
}
