# leocodebox 视觉升级 QA

## 设计基准

- 组合设计参考：`/Users/leoyuan/.codex/generated_images/019f44bd-17f1-7831-bf61-79bef22da52b/exec-12f73832-b199-42ad-8d65-a134b599c3ce.png`
- 实机截图目录：`/Users/leoyuan/Desktop/leocodebox-ui-upgrade/`
- 验证环境：macOS、Electron 43.1.0、系统/浅色/深色三种主题模式

## 已验证范围

- 桌面应用导航、项目列表、会话工作区、状态栏和运行态信息层级统一。
- 设置、Leoapi、本地记录和启动等待页使用同一套中性色、青绿色品牌色、间距和动效规则。
- 深色、浅色与跟随系统模式可切换，Electron 外层窗口与 Web 内容同步。
- 动画集中在页面进入、弹窗、运行状态和操作反馈；系统减少动态效果时自动降级。
- 本地开发模式使用显式认证令牌并只放行精确回环开发源，生产模式不受影响。

## 问题与修复

- P1：开发预览因桌面令牌与服务令牌不一致回到登录页。已增加显式开发令牌和精确开发源校验。
- P1：Web 内容切换深色后 Electron 外层标题栏仍为浅色。已增加受信 IPC 主题桥接并完成实机验证。
- P2：侧栏供应商颜色过多，信息噪声高。已改为中性标签和单一品牌状态色。
- P2：空状态占用过大且操作路径不清晰。已改为紧凑的三步工作指引。
- P2：Leoapi 与主应用像两个产品。已统一标题栏、列表结构、控件尺寸、主题和动效。
- P2：设置层级松散且英文标签偏多。已统一中文标签、紧凑导航和系统主题选项。

## 自动化结果

- `npm test`：177 项通过，0 失败。
- `npm run test:clean-device`：通过；全新 HOME 无登录，6 个 Agent CLI 均被发现且可运行。
- `npm run typecheck`：通过。
- `npm run build`：客户端与服务端生产构建通过。
- `npm run desktop:pack`：通过；打包版主界面、Leoapi 返回/关闭入口和本地 38473 服务完成实机验收。
- `npm run lint`：0 错误；仓库现有 249 条警告未纳入本次视觉改造范围。
- `git diff --check`：通过。

final result: passed
