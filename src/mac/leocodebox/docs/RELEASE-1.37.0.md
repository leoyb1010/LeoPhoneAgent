# leocodebox 1.37.0

发布日期：2026-07-11

## 重点升级

- 统一桌面导航、项目侧栏、Agent 工作区、设置、Leoapi、本地记录和启动页视觉。
- 增加浅色、深色、跟随系统三种主题，并同步 Electron 外层窗口。
- 修复不同 Mac 上 Claude Code、Codex、OpenCode、Cursor、Gemini、Hermes CLI 的发现与运行路径继承。
- 修复多会话并行输出串流、provider 归属和切换会话时的文本截断问题。
- 收紧 Electron IPC 与 BrowserView 导航，只允许精确的内置页面使用桌面特权。
- 加固 Agent 工作区路径、Git ref 参数、CORS、WebSocket 重连和本地服务并发启动。
- 增加面板级错误隔离，单个工具异常不再导致整个应用白屏。
- 精简无用运行依赖，生产依赖审计保持 0 漏洞。

## 更新兼容

`1.37.0` 高于历史 `1.36.3` 桥接构建：

- 已安装 `1.36.1` / `1.36.2` 的设备可以直接升级。
- 已经迁移到 `1.1.3` 的设备也可以直接升级。
- 从本版本开始恢复正常递增版本号，不再复用旧 Release 版本。

## 安装包

- macOS Apple 芯片：`leocodebox-1.37.0-mac-arm64.dmg`
- Developer ID 签名、Apple 公证并附加公证票据。
- 仓库为 Private，下载与应用内更新需要有仓库读取权限的 GitHub 账号或 Token。
