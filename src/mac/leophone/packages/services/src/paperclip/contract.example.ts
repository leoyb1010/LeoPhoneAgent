import type { IPaperclipWorkspace } from "./contract.js";
export async function connectPaperclipExample(workspace: IPaperclipWorkspace): Promise<void> {
  await workspace.configure("https://paperclip.example.com");
  await workspace.signIn();
  // 配置只含 origin 与公司偏好；登录 Cookie 由原生适配器持有。
}
