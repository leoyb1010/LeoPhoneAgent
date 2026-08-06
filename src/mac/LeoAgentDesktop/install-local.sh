#!/bin/bash
# 把构建好的 LeoAgent.app 装到 ~/Applications 并启动。
#
# 为什么需要这个脚本,而不是直接拖进去:
#
# 我们用的是 ad-hoc 签名(codesign -s -),它每次重建都会产生不同的代码身份。
# macOS 的钥匙串把条目的访问控制绑在代码身份上,于是新构建去读上一版建的
# "LeoAgent Safe Storage" 条目时,系统会弹一个授权对话框要你输密码。
#
# 那个弹窗是**模态**的:没人点,Electron 主进程就一直停在建窗之前——表现为
# "双击没反应、没有窗口、日志停在固定一行"。这不是代码 bug,查了很久才定位到。
#
# 所以装机前先删掉旧条目:app 会自己新建一个(创建不需要授权,只有读别人
# 建的才需要),弹窗不再出现。数据代价为零——那个条目里只有 app 自己的
# 加密密钥,删了等于让它重新生成。
set -euo pipefail
cd "$(dirname "$0")"

APP_SRC="apps/desktop/out/LeoAgent-darwin-arm64/LeoAgent.app"
APP_DST="$HOME/Applications/LeoAgent.app"

[ -d "$APP_SRC" ] || { echo "❌ 没有构建产物,先跑 pnpm --filter desktop run package"; exit 1; }

echo "▸ 退出正在运行的实例"
osascript -e 'tell application "LeoAgent" to quit' 2>/dev/null || true
sleep 2
pkill -f "LeoAgent.app" 2>/dev/null || true
sleep 1

echo "▸ 清掉旧签名遗留的钥匙串条目(避免模态授权弹窗卡住启动)"
security delete-generic-password -s "LeoAgent Safe Storage" >/dev/null 2>&1 || true

echo "▸ 安装到 $APP_DST"
rm -rf "$APP_DST"
xattr -cr "$APP_SRC" 2>/dev/null || true
cp -R "$APP_SRC" "$HOME/Applications/"
xattr -cr "$APP_DST" 2>/dev/null || true
codesign --force --deep --sign - "$APP_DST" 2>&1 | tail -1

echo "▸ 启动"
open "$APP_DST"
echo "✅ 完成。日志:~/Library/Application Support/LeoAgentGlobal/logs/"
