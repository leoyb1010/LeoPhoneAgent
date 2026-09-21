import { homedir } from "node:os";
import { join } from "node:path";

// [leo] host、agent、MCP 等子进程统一用 LeoPhoneAgent 自己的数据根,
// 绝不落到官方客户端的 ~/.zcode(那里有官方 CLI 的配置、账号和会话)。显式设置了 ZCODE_HOME 时尊重它。
if (!process.env["ZCODE_HOME"]?.trim()) {
  process.env["ZCODE_HOME"] = join(homedir(), ".leophoneagent");
}
