# LeoAgent Desktop

LeoAgent 的桌面端。它托管你自己机器上已经装好的编码 CLI(Claude Code、Codex),
把它们变成可对话、可转向、可审批的长活会话,并与 LeoAgent 的手机端、手表端组成
一套"手机是主控制面、Mac 是第二具身体"的个人 Agent 系统。

## 与手机端的关系

- 手机端(`src/ios`)本身是完全体 Agent,离开这台 Mac 也能独立工作。
- 这台 Mac 是第二具身体:它有自己的算力、自己的文件、自己已登录的 CLI。
- 两者通过 tailnet 直连,不经过任何第三方云。

## 本地优先

- **不依赖任何远端配置服务**:端点清单随包内置(`apps/desktop/resources/endpoints/`)。
- **不下载厂商二进制**:直接使用你 PATH 上已装好、已登录的 `claude` / `codex`——
  你在终端里跑的是哪一个,这里跑的就是哪一个。
- **不需要账号**:启动后选本地模式;模型走你自己的 API key 或自定义端点。

## 构建

需要 Node 22 与 pnpm 10/11:

```bash
pnpm install
pnpm --filter desktop run package
```

产物在 `apps/desktop/out/LeoAgent-darwin-arm64/LeoAgent.app`。

开发模式:

```bash
pnpm dev:desktop
```

## 验证

```bash
pnpm test:unit
pnpm --filter desktop typecheck
```

## 出处与许可

本项目 vendored 自 [Cindy 开源客户端](https://github.com/makecindy/cindy)
(Apache-2.0)并做了改造。上游基线、逐项改动清单与商标边界见 [NOTICE](NOTICE),
许可证全文见 [LICENSE](LICENSE)。上游自带的贡献者文档保留在
[`docs/upstream/`](docs/upstream/),其中的流程规则适用于上游仓库,不适用于本仓。
