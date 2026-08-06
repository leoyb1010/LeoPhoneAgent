# LeoPhoneAgent

[![Version](https://img.shields.io/badge/iOS-1.8.3%20(56)-0A84FF.svg)](src/ios/Views/Settings/ReleaseNotesView.swift)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)
[![Primary platform](https://img.shields.io/badge/primary-iOS-black.svg)](#当前-ios-版本)

**个人 AI Agent:iPhone 是主控制面,三台 Mac 是"第二具身体"。**

手机端本身是一个完整的端上 Agent(模型接入、Linux 沙箱、浏览器自动化、
技能与记忆);同时通过自营中继,在任意网络(蜂窝/WiFi)远程指挥任意一台
Mac 上的编码 CLI(Claude Code / Codex / Grok),支持断线续传、远程审批、
会话接管。Mac 侧另有一个完整的桌面端(Cindy 开源桌面的深度改造版)。

> 本仓库是 [OpenMinis](https://github.com/OpenMinis/OpenMinis) 的独立 GPLv3
> fork,与 OpenMinis 官方产品无关,亦未获其背书。

## 系统架构

```text
┌─ iPhone(iOS app,主控制面)──────────────────────────┐
│  端上 Agent:多模型接入 / iSH Alpine 沙箱 / 浏览器自动化  │
│  Mac 遥控:对话框直达三台 Mac 的 CLI,审批/转向/接管      │
└──────────────┬───────────────────────────────────────┘
               │ HTTPS(公网,Tailscale Funnel 入口)
┌──────────────▼───────────────────────────────────────┐
│  自营中继 relay.py(常驻 Mac mini「cortex」)           │
│  Mac 出站 WebSocket 注册;手机一把钥匙直达全部机器        │
└──────┬───────────┬───────────┬───────────────────────┘
   ws出站│      ws出站│      ws出站│
┌──────▼───┐ ┌─────▼────┐ ┌────▼─────┐
│ MacBook  │ │ Mac mini │ │ Mac Studio│   每台跑 leoagent 常驻服务:
│  Pro     │ │ (cortex) │ │           │   claude/codex/grok 无头会话
└──────────┘ └──────────┘ └───────────┘   NDJSON 日志 + SSE 续传 + 审批
```

- **连接模型**:Mac 主动出站连中继(穿 NAT),手机走公网 HTTPS——两端在
  任意网络均可,手机无需 VPN/Tailscale 客户端/SSH。
- **协议**:自研 harness 协议(单调 seq 的 NDJSON 事件日志,SSE `?after=N`
  回放再跟随),断线不丢事件;审批带独立 `approval_id`,手机/手表均可应答。
- **CLI 方言**:Claude Code(stream-json)、Codex(app-server JSON-RPC)、
  Grok(`grok agent stdio`,ACP/Agent Client Protocol)。
- **安全**:一把 ≥16 字符密钥保护中继与全部端点(个人产品,单用户模型);
  Funnel 只挂中继路径;密钥自动清洗复制残渣(尾部 `%`/换行)。

## 仓库布局

```text
src/ios/                iOS 主 app(Swift/SwiftUI)+ Share/FileProvider/Widget/Watch
src/mac/leoagent/       Mac 常驻服务:server.py(harness 会话)、relay.py(中继)、
                        relay_client.py(出站注册)、harness.py(CLI 方言翻译)
src/mac/LeoAgentDesktop/ Mac 桌面端:Cindy(Apache-2.0)深度改造,全量去牌、
                        本地模式、舰队监控、设置重组+搜索(见其内 NOTICE)
src/mac/LeoAgentMac/    菜单栏状态 app(SwiftUI,轻量)
src/android/            Android(保留,暂缓)
deps/  docs/  scripts/  原生依赖构建、文档、工具
```

## 当前 iOS 版本

- 版本/构建:`1.8.3 (56)`;Bundle ID `com.leoyuan.leophoneagent`
- 主对话框直达 Mac:「指挥一台 Mac」选机 + 选 CLI 即开聊;发送在会话建立
  期间自动排队,永不吞点击
- 会话接管:进入任意 Mac 先列进行中任务,一键接管(全量回放 + 实时跟随)
- Grok 模型接入:「从 Mac 借用登录」——手机不跑 OAuth,向 Mac 的
  `/v1/grok/token` 借自动续期的 access token(refresh 链由 Mac 独占)
- 更新机制:每次发版内置更新说明,首启弹「本次更新」卡(发版铁律见
  [CLAUDE.md](CLAUDE.md))

## 构建

iOS(需 Xcode 26+,真机 ARM64):

```sh
git clone --recurse-submodules https://github.com/leoyb1010/LeoPhoneAgent.git
cd LeoPhoneAgent
./deps/build_lame.sh && ./deps/build_ffmpeg.sh && ./deps/build_ish.sh && ./deps/prepare_alpine_rootfs.sh
open src/ios/LeoPhoneAgent.xcodeproj
```

Mac 常驻服务(每台受控 Mac):`src/mac/leoagent/` 由 launchd 拉起
`server.py`;中继机额外跑 `relay.py` 并用 `tailscale funnel --set-path`
暴露公网路径。桌面端见 `src/mac/LeoAgentDesktop/`(pnpm,
`install-local.sh` 安装,内有构建注意事项)。

## 来源与许可

- 主仓库:GPLv3,fork 自 OpenMinis(基线
  [`9cf3a855`](https://github.com/OpenMinis/OpenMinis/commit/9cf3a855fecd27bb5735b84cacbd56852a3ab8dd),
  保留 `upstream` remote;升级流程见 [UPSTREAM_SYNC.md](docs/UPSTREAM_SYNC.md))。
- `src/mac/LeoAgentDesktop/`:基于 Cindy 开源桌面(Apache-2.0)改造,
  基线与逐文件修改清单见该目录 `NOTICE`;未使用其商标。
- 第三方致谢与许可证文本:[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

分发修改后的二进制须按各自许可证提供对应源码并保留声明。LeoPhoneAgent /
LeoAgent 名称与图标仅标识本 fork。
