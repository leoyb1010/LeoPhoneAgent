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
- 只开放所需 API 路由和方法，不提供任意 fetch、header、Cookie 或 Authorization 能力
- 每个 origin 独立持久会话；Cookie 不进入 renderer、日志或普通偏好设置
- 登录窗口没有 Node、preload、权限授权、外部导航和弹窗；中断后必须能重新登录
- API 请求不跟随重定向、不自动重试，超时向服务层报告未知结果；不回退本机执行
- 默认工作区在 Main 的 Host admission 之前短路，本机 Agent/定时任务不随服务器入口启动。显式本地恢复才启动旧 Host；返回服务器保留用户已明确启动的旧会话，不迁移或杀掉它
- 会话返回仅提供用户标识和到期信息，剔除 token；退出注销服务器会话并清理隔离会话
- 产物下载只接受服务器受控附件/资源路径，经系统另存为确认后保存，不自动打开或执行

## 验收

纯策略测试覆盖 URL/方法/路径绕过、跨源重定向、令牌清理及下载文件名。实际 Electron 登录和取消/重入需在可运行桌面环境验证；无授权服务器时不声称完成真实服务器验收。Mac CI 编译 main/preload 与 renderer，客户端测试独立覆盖丢失响应和重连。
