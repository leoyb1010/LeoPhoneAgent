# Paperclip 原生传输边界

基于 Paperclip `994d6edcdd4e15d5f9cc5cf8c135ac599104b86a`，人类操作者使用 Better Auth 会话，不能用智能体 API 密钥代替。

## 状态所有者与顺序

```text
中文工作台 → 服务契约 → preload 固定 IPC → Main 网络适配器
                                       └→ 每个服务器 origin 的隔离 Chromium 会话
登录按钮 → 无 preload 的受限登录窗口 → /auth → /api/auth/get-session
                                       └→ 验证 user.id 后关闭，工作台重新读取公司
任务命令 → 工作台 mutation receipt → 单次 HTTP 请求 → 服务器唯一任务/运行状态
```

Main 只拥有网络会话、登录窗口和下载 IO，不拥有任务队列或业务状态。服务层负责环境身份、未知提交结果、重连和防止陈旧结果覆盖。

## 不变量

- 服务器必须是 HTTPS origin；只允许明确输入的 localhost / 127.0.0.1 / [::1] 使用 HTTP 进行本机开发。拒绝用户名、密码、子路径、查询和 fragment
- IPC 只允许应用自己的顶层 renderer，禁止子框架、登录窗口和远程页面调用
- 只开放服务层实际调用的路由：13 条 GET、5 条 POST、1 条 PATCH（`policy.ts` 逐条列出，`policy.test.ts` 同时断言这些路由放行、旧表中未使用的路由被拒）；不提供任意 fetch、header、Cookie 或 Authorization 能力。服务层新增调用时必须同步扩充白名单与测试
- 每个 origin 独立持久会话；Cookie 不进入 renderer、日志或普通偏好设置
- 登录窗口没有 Node、preload、权限授权、外部导航和弹窗；中断后必须能重新登录
- 登录成功、取消、超时或 owner 关闭时，由 Main 强制销毁登录窗口；远端页面的 beforeunload 不能阻止终止。窗口销毁后才释放登录记录和返回结果，注销随后等待旧 IO 并清理隔离会话
- API 请求不跟随重定向、不自动重试，超时向服务层报告未知结果；不回退本机执行
- 默认工作区在 Main 的 Host admission 之前短路，本机 Agent/定时任务不随服务器入口启动。显式本地恢复才启动旧 Host；返回服务器保留用户已明确启动的旧会话，不迁移或杀掉它
- 会话返回给 renderer 的只有 `user.id`、`user.name`、`user.email` 与 `session.expiresAt`，不含 token、会话 id 或 Cookie；退出注销服务器会话并清理隔离会话
- 产物下载只接受服务器受控附件/资源路径，经系统另存为确认后保存，不自动打开或执行
- 下载必须携带任务绑定的 expectedUserId；打开另存为前捕获会话代际，确认路径后重新核对代际、注销状态和服务器当前用户。文件读取与写入同属该 origin 的 IO 生命周期，保存前再次检查代际及取消信号；旧对话框不能在注销或切账号后发出附件请求或保存文件

## 身份确认与超时

带 `expectedUserId` 的请求先确认服务器当前用户。身份绑定不能删除（账号隔离依赖它），但同一 origin 的 `PaperclipSessionScope` 合并重复查询：

```text
读请求 ─┬─ 2 秒内已确认且未失效 → 直接使用确认结果
        └─ 否则 → 加入进行中的 get-session 或发起一次 → 结果写入短缓存
写请求/附件下载 → 不读缓存；只可加入进行中的查询，否则新发起一次
失效事件：注销开始/结束、登录窗口创建/销毁、隔离会话 Cookie 变化、非 get-session 的 401
```

失效推进身份版本：失效前发起的查询结果仍作为本次请求的实时回答，但不写入缓存，失效后的请求不会加入旧查询。普通 API 超时 60 秒；附件下载（最大 64 MB）使用独立的 10 分钟超时。

日志：Main 记录登录窗口创建/销毁、注销开始/完成（info），401、重定向拦截、身份不一致（warn），非主动取消的传输异常（error）。日志只含事件、方法与状态码，不含 Cookie、token、请求体、邮箱或服务器地址。

## 验收

纯策略测试覆盖 URL/方法/路径绕过、跨源重定向、令牌清理及下载文件名。实际 Electron 登录和取消/重入需在可运行桌面环境验证；无授权服务器时不声称完成真实服务器验收。Mac CI 编译 main/preload 与 renderer，客户端测试独立覆盖丢失响应和重连。

`transport.electron.test.ts` 在 macOS 使用真实 Electron、真实传输 IPC、临时 loopback 登录页和独立 userData，先确认 beforeunload 能阻止普通 close，再验证注销销毁窗口并清理 fixture Cookie，随后重新登录成功仍销毁窗口。下载回归仅将原生另存为对话框替换为可控的待确认结果，实际 IPC、身份查询、附件网络读取及文件保存均执行真实实现，验证选择期间注销/切账号后不发送附件请求、不保存文件。该回归不读取真实账号、会话或产品数据；不能替代真实 Paperclip 服务器验收。
