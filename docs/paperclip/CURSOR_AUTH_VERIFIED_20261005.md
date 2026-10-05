# Cursor 服务器授权验收 · 2026-10-05

用户完成 Mac mini 钥匙串解锁与 Cursor 浏览器授权后，使用服务账号的 `~/.local/bin/cursor-agent`，在与服务器一致的 gui/501 后台安全会话及代理环境验证。

## 结果

- CLI：2026.10.01-e373342。
- `--list-models` 返回当前完整目录，包含 `claude-opus-5-5-medium`、`claude-fable-5-1-medium` 及其完整档位；这些模型 ID 不能截断后拼接猜测。
- Composer 2.5：真实请求 exit 0、success、is_error=false，返回 `CURSOR_AUTH_OK`。
- Fable 5.1 Medium：真实请求 exit 0、success、is_error=false，返回 `CURSOR_AUTH_OK`。
- Opus 5.5 Medium：目录中存在，但本次 35 秒预算内未返回，进程清理后 exit 124；不计为真实响应通过，也不称其权限不存在。

## 配置落地

通过生产 `agentService.update` 更新现有 LeoCursor：默认模型设为已验证的 `claude-fable-5-1-medium`，移除该智能体 `env.CURSOR_API_KEY` 旧覆盖，使用服务器 CLI 登录。旧 secret 本体保留，其他配置和权限保持；配置修订与 system 维护活动已记录。数据库回读确认模型与覆盖移除，服务不需要重启。

变更前配置以私有 0600 文件保存在 Mini 项目外接盘 `cursor-authorization-20261005/leocursor-before.json`。真实请求、模型目录及退出码同目录保留；临时 GUI 验证任务已卸载。

## 验证环境纠正

初次 SSH CLI 提示钥匙串锁定。GUI 后台上下文能正确读取新登录；不能据 SSH 提示断言后台授权失败。第一次独立验证进程未继承服务器代理，得到不完整模型列表并拒绝旧 Opus ID；继承实际代理后完整列表确认该 ID 有效。这是验证环境差异，已纠正，不用于删除正常模型。

本次证明 CLI 登录、完整模型目录和 Fable 真实调用，不把模型出现在列表中等同于其真实请求成功；没有创建或修改用户任务来冒充完整业务闭环。
