# leocodebox 1.52.0 —「首页驾驶舱」

进入 App 默认落在一个新的**首页驾驶舱**:一屏看清账号与 Agent 授权状态、运行中会话、分模型用量、Claude 窗口消耗、Mission 进度、系统健康与更新。配套一轮设计系统/动效升级。全程本地优先、无新增网络面、向后兼容。

## 多了什么

**首页驾驶舱(三栏响应式)**
- 左栏:7 个 CLI 各一卡——登录态点(绿/灰/红)、邮箱、版本、可更新提示、未安装一键装
- 中栏:运行中会话(Live 呼吸点 + 秒表 + 可点跳会话)+ Mission 看板摘要(四列计数 + 最近 running)
- 右栏:用量中心——今日三数字(滚动 tween)+ Claude 窗口消耗 + 分模型占比 + 各 CLI 累计 + 7 日趋势柱状图
- 顶部 Hero:问候 + 本地账号 + Doctor 健康灯 + 版本/更新角标 + 刷新;底部快捷操作带(Doctor / 检查更新 / 配置备份 / 回收站)

**Claude 窗口消耗服务**——扫描本地 jsonl 聚合 5h/7d 窗口的真实 IO tokens、等价成本、轮数与 token 构成;正确排除 cache_read(重复读取不计入限额)。诚实标注「本地实测 · 不含缓存读取与其他设备」,不编造无法得知的「剩余百分比」(Anthropic 不公开 Pro/Max 绝对限额)。

**设计系统/动效升级**——新增动效曲线/时长 token、阴影阶梯、入场/悬停/Live 呼吸/进度条动效类,全部尊重 `prefers-reduced-motion`;只在承载信息处动。

## 接线细节
- 新增 tab `dashboard`,默认落地页改为驾驶舱(有持久化 tab 的老用户保留原习惯);左侧栏首位「首页」导航项;懒加载 + ErrorBoundary + Suspense
- 新增 `GET /api/usage/claude-quota` 与计划档位 GET/PUT 端点
- 10 种语言补 `workspaceShell.dashboard` 标签

## 验证
- 门禁全绿:typecheck 0 error、ESLint 0 警告(含自定义 design-system 规则)、生产构建通过(DashboardView 懒加载分包)
- 测试:client 71/71、server 299/299
- **修复一处发布阻断**:随包的 better-sqlite3/node-pty/bcrypt 原生模块此前被按 plain-node ABI 重建(会导致打包后 Electron 加载 DB 失败),已 electron-rebuild 回 Electron 43 ABI,server 测试 299 全绿、原生模块可正常加载

## 下载校验
- DMG SHA-256:`23116b806d8fbaf6ea25c92104f321679066cfe3705b8840c87242691d346d9b`
- ZIP SHA-256:`0e00619ca1c0ceeba0de8db597e42e0dd61b9141dc50427c28b53a20ab092a43`
- `latest-mac.yml` SHA-256:`eee4463f716048a286cf7892cf3afab64768f4c80b5acfa8a46623940eb0e97e`
