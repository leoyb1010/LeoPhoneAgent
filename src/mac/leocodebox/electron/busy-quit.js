export function shouldConfirmBusyQuit({ busy, keepServer } = {}) {
  return Boolean(busy) && !keepServer;
}

export function busyQuitCopy() {
  return {
    message: '还有会话在跑',
    detail: '现在退出会停掉正在跑的。',
    stay: '接着跑',
    quit: '退出',
  };
}
