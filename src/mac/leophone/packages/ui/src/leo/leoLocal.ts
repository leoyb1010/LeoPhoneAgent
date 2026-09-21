/**
 * [leo] 本机 Leo 服务(host 进程里的 127.0.0.1 小服务)的入口地址。
 * 订阅账号(Claude / ChatGPT / Copilot 等)登录页在系统浏览器里打开,凭据只存在本机 ~/.leoagent/oauth。
 */
export const LEO_LOCAL_ORIGIN = "http://127.0.0.1:38473";
export const LEO_OAUTH_PAGE_URL = `${LEO_LOCAL_ORIGIN}/leo/oauth`;
