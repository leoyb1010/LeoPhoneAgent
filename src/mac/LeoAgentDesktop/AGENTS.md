# LeoAgent Desktop — 工作入口

本目录是 LeoAgent 的桌面端,vendored 自 Cindy 开源客户端(Apache-2.0)后改造。
上游基线与改动清单见 `NOTICE`。

## 这份文件的由来

vendor 进来时上游自带一份 `AGENTS.md`(它们的贡献者规则:DCO 签名、PR-first、
它们的 CI 门禁、它们的设计规范索引)。那些是**上游项目对其贡献者**的要求,不是
本仓的规则,已整体替换——否则在本仓工作的 agent 会去遵守一套针对别人仓库的流程。
需要查上游的工程约定时,去 `docs/dev-rules/` 读原文,但**以本文件为准**。

## 本仓规则

- 遵循 LeoPhoneAgent 根仓的工作方式(见仓库根 `CLAUDE.md` / 用户全局指令)。
- 本目录是 vendored 分支:**改动要可追溯**。凡是改到上游文件,在 `NOTICE` 的
  改动清单里补一条(Apache-2.0 §4(b) 的要求,也是将来跟上游 rebase 的地图)。
- 品牌改名只改两处单一事实源:`packages/maker-shared/src/branding.ts`(展示名)
  与 `brandIdentity.ts`(标识符层)。改标识符层要同步四个镜像点,
  `scripts/__tests__/brand-identity-sync.test.mjs` 会拦。
- **不要**重命名 `@cindy/*` npm scope、`xdtMaker.*` 设置键、`xdt-*` 内部协议:
  它们是内部标识符,用户看不见,改了只会制造数据迁移事故。
- 端点:打包版读随包内置的 `apps/desktop/resources/endpoints/endpoint.json`,
  不依赖任何远端配置服务。改端点改这个文件 + `config/endpoint*.json`。
- 本产品自持部署,登录走 local 模式,模型走 BYOK / 自定义端点。

## 构建

```
pnpm install                        # 需 node 22 + pnpm 10/11
pnpm --filter desktop run package   # → apps/desktop/out/LeoAgent-darwin-arm64/LeoAgent.app
```

## 继承自上游的工程文档

这些文档描述的是代码本身怎么跑,与贡献流程无关,继续有效:

- 环境搭建、依赖修复、新 worktree:`docs/dev-rules/environment-setup.md`
- 启动 / 调试 / 验证桌面端:`docs/dev-rules/desktop-development.md`
- 移动端(本产品的手机端是独立的 iOS 工程,这份仅供参考):
  `docs/dev-rules/mobile-development.md`
- Electron 进程边界与安全:`docs/dev-rules/electron-security-and-process-boundaries.md`
- 数据库 schema 与迁移:`docs/dev-rules/database-and-migrations.md`
