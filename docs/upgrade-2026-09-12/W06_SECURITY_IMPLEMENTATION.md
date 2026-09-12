# W06：Mac 依赖与桌面写入来源

2026-09-12，本地主仓工作区实现，未发布 Mac 安装包。

## 改动与证据

通知设置原先允许任意 renderer 调用持久化写入。现在经过统一 trustedHandle，来源必须是当前本地服务端口或精确内置启动页，并且属于发送 WebContents 的主 frame。子 frame、缺失 frame、外部文件及错误端口在写入前拒绝。相同 frame 校验同时用于其他特权桌面操作和本地认证令牌读取。

新增测试直接加载 main.js 的实际来源判断与 IPC 注册函数：修复前 8 项中 6 项失败，修复后全部通过。全部桌面测试 45/45。额外用真实 Electron 隐藏测试窗口、隔离用户目录及临时本地服务器验证：本地主 frame 与内置页写入成功，同源 iframe 与外部文件均被拒绝，实际写入次数恰好为 2。测试仅使用临时设置接收器，未修改用户桌面通知偏好。

锁定对应修复版本：multer 2.3.0、hono 4.13.5、js-yaml 3.15.2 / 4.3.2、sharp 0.35.4。保留 js-yaml 两个主版本，未跨主版本替换旧调用方。修正 overrides 的匹配范围，防止只修改声明却保留旧锁定依赖。

官方 npm 生产审计从 8 个受影响节点降至 0；包含开发依赖的完整审计也是 0。sharp 原生 PNG 解码、缩放、WebP 编码及尺寸回读通过。

前端测试 194/194、前端 production build、修改文件 ESLint 与 diff 空白检查通过。

## 整体构建边界

当前全服务端测试 443 项中 440 通过、3 项失败，失败全部来自尚未接完的 W04 harness-journal 集成：HarnessSession 缺少 flushJournal / closeJournal / journalOptions，buildReceipt 仍同步返回而非等待持久化。全量 TypeScript 检查同样因这些缺失及 journal 的空行类型错误失败。未删除这些测试，也未将全量构建标为通过。W04 是下一项修复，不属于外部阻塞。

所有原始日志在 `outputs/implementation-2026-09-12/mac-security/`。此项通过不代表完整升级目标完成，也不代表已发布或安装 Mac 新版本。

## 来源

- npm audit 官方输出中的通告及修复范围保存在 audit-before.json 和 audit-after.json。
- [Electron WebFrameMain](https://www.electronjs.org/docs/latest/api/web-frame-main) 与 [WebContents](https://www.electronjs.org/docs/latest/api/web-contents) 定义了主 frame / 子 frame 对象；最终可用性由上述真实 Electron IPC 测试确认。
