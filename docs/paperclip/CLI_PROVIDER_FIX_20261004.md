# Mini CLI 安装与 OpenCode 提供商选择交付 · 2026-10-04

## 部署范围

服务器主机为 Mac mini 服务器（服务账号用户），项目根为 `<部署根>`（外接盘上的项目目录）。公网入口为 `https://paperclip.leoyuan.top`，服务监听 `127.0.0.1:43871`。本次只修改服务器 Web 配置界面并补装 CLI，不修改手机安装包或用户既有智能体配置。

## CLI 安装

服务等效 PATH 下检测九种可执行入口：Codex 0.160.0、Claude 2.1.285、Grok 1.0.46、Cursor `agent`、Gemini 0.62.0、Kimi 2.1.1、OpenCode 1.18.34、Pi 1.0.2、Hermes 0.21.5+6718.g158fd63.dirty。

八种版本命令退出 0；Cursor 可执行入口存在，但本次版本命令超过 8 秒未返回，未以此宣称运行验证成功。安装状态不等于授权、模型请求或任务执行成功。新安装 CLI 的授权由用户自行完成。

新增包为官方 `@moonshot-ai/kimi-code@2.1.1` 与 `@earendil-works/pi-coding-agent@1.0.2`，安装于项目 `runtime/cli/npm`，通过服务账号 `~/.local/bin` 的链接复用现有服务 PATH。包缓存与临时文件位于外接盘。没有迁移共享 CLI 的原认证目录。

Kimi 版本/帮助、Paperclip 使用的旧 `-r` 参数兼容检查通过；修正安装包 PTY spawn-helper 的执行权限后，真实 PTY 子进程 `/usr/bin/true` 退出 0。Pi 版本/帮助及适配器所需参数检查通过。远端无凭据安装清单保存于 `repair-native-cli-login-20261004/cli-install-inventory.json`。

## Gemini 实际结果

用户的 Google 页面已显示授权成功；Mini 的 OAuth 缓存写入成功。使用已有认证、禁止自动调起浏览器，在本次新建空诊断目录运行最小无工具请求，得到 `IneligibleTierError`：

> This client is no longer supported for Gemini Code Assist for individuals.

这是登录之后的 Google 服务初始化拒绝。CLI 版本为 0.62.0，排查时 npm 最新版本也为 0.62.0，不能通过重复授权或简单升级解决本次拒绝。未清空认证、修改账号或伪装其他 Google 客户端。上述结果只说明本次请求被拒绝，不推断所有 Google 账号均不再支持 CLI。

Google 官方提供的连接方式见 [Gemini CLI 身份验证](https://geminicli.com/docs/get-started/authentication/)；API 密钥、符合资格的 Cloud 项目或提示中的迁移路径需要用户自行选择，未替用户更改计费或认证方式。

## OpenCode 修复与验证

上游新建配置在选择 OpenCode 时会立即生成 OpenRouter 个人 API 连接，使提供商选择被隐藏。本次移除这个隐式绑定，恢复原有提供商选择和各提供商环境变量；保留明确选择的 OpenRouter 连接管理，并允许返回服务器 OpenCode 配置。

- 4 项真实 `NewAgentSetup` 组件测试先失败，修复后全部通过，覆盖默认无绑定、OpenAI/Anthropic 选择和显式连接/返回配置。
- 2 项源码与生成结果契约通过；UI TypeScript 检查、Vite 生产构建通过。
- 600 文件协议静态检查通过，只有隐式默认绑定移除的精确例外，未放宽通用检查。
- 公网浏览器实际验证选择 OpenCode 后仍可选择 OpenAI；没有输入 API 密钥、创建测试智能体或修改用户已有配置。截图保存在本次工作区 `artifacts/paperclip-agent-runtime-fix-20261004/opencode-openai-provider-choice.png`。

部署将新的 UI 与当前 UI 原子交换，保留旧目录和旧散列静态资源，不重启服务。新主资源 `index-D7JqpIeS.js`，首页 SHA-256 `4285762941b4f6298682f6e7cb07933487945b0ffaa97829a79e4a6b1310006c`。本次未使用新的提供商密钥执行 OpenCode 真实模型请求，不能把界面验证等同于所有模型可用。
