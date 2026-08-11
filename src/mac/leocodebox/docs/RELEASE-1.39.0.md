# leocodebox 1.39.0

## 本机智能体更新

- 新增 Grok Build (`grok`) 的跨设备发现、版本显示和官方自更新入口。
- 修复 Homebrew Node 全局 npm 包被误判为 brew formula 的问题。
- 支持 npm、Homebrew/Cask、pnpm、Volta、Bun、Cursor/OpenCode/Hermes/Grok 独立安装器。
- Cursor、Hermes、Grok 无公共版本源时显示“检查并更新”，不再误报“已是最新”。
- 增加批量更新、手动命令复制、失败输出、300 秒超时和加载骨架屏。
- Windows 使用 `where` 发现命令，并支持 `.cmd`/`.bat` 包装器。

## 安全与质量

- CLI 与插件的安装、更新、启停、删除统一限制在桌面本机模式。
- 测试目录覆盖仅在 `NODE_ENV=test` 生效；未知工具 ID 使用 own-property 校验。
- 修复预发布版本比较，补充来源、更新命令、门禁和原型链回归测试。
- API 文档收录本机 CLI 状态、安装和更新接口。

## 发布说明

应用更新支持 GitHub Token 私有源或 `LEOCODEBOX_UPDATE_URL` generic feed。当前仓库和 Release 为私有，匿名更新无法绕过 GitHub 权限；令牌继续由系统钥匙串加密保存。
