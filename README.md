# LeoPhoneAgent

[![iOS](https://img.shields.io/badge/iOS-1.23.1%20(93)-0A84FF.svg)](src/ios/Views/Settings/LeoReleaseNotesView.swift)
[![Android](https://img.shields.io/badge/Android-1.0.0--alpha.1-3DDC84.svg)](#当前-android-版本)
[![macOS](https://img.shields.io/badge/macOS-1.67.1-7C3AED.svg)](src/mac/leocodebox/package.json)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)
[![Mobile](https://img.shields.io/badge/mobile-iOS%20%2B%20Android-black.svg)](#系统架构)

**个人 AI Agent：iPhone 与 Android 都能独立工作，三台 Mac 是“第二具身体”。**

手机端本身是一个完整的端上 Agent（模型接入、Linux 沙箱、浏览器自动化、
技能与记忆);同时通过自营中继,在任意网络(蜂窝/WiFi)远程指挥任意一台
Mac 上的编码 CLI(Claude Code / Codex / Grok),支持断线续传、远程审批、
会话接管。Mac 侧另有一个完整的桌面端(Cindy 开源桌面的深度改造版)。

Android 端以 OpenMinis 的 Kotlin/Compose 共同历史为底座，提供 Standard
与 Power 两种构建；Power 版为 Accessibility、Shizuku 与受控系统操作预留
独立能力闸门，不改变 iPhone 独立运行或现有 Mac Relay 协议。

> 本仓库是 [OpenMinis](https://github.com/OpenMinis/OpenMinis) 的独立 GPLv3
> fork,与 OpenMinis 官方产品无关,亦未获其背书。

## 系统架构

```text
┌─ iPhone(iOS app,主控制面)──────────────────────────┐
│  端上 Agent:多模型接入 / iSH Alpine 沙箱 / 浏览器自动化  │
│  Mac 遥控:对话框直达三台 Mac 的 CLI,审批/转向/接管      │
└──────────────┬───────────────────────────────────────┘
┌─ Android(Kotlin/Compose,独立控制面)──────────────────┐
│  端上 Agent:多模型 / PRoot Alpine / Skills / MCP       │
│  Power Engine:Accessibility / Shizuku / 受控系统操作    │
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
src/android/            Android 主 app(Kotlin/Compose)+ PRoot/Accessibility/Shizuku
src/mac/leocodebox/     LeoPhoneAgent · Mac:Electron 桌面工作台、CLI 管理、
                        本机服务、会话/技能/MCP 与跨设备控制
src/mac/leoagent/       Mac 常驻服务:server.py(harness 会话)、relay.py(中继)、
                        relay_client.py(出站注册)、harness.py(CLI 方言翻译)
                        ※ harness 面已由 leocodebox 1.63+ 接管(协议同构);
                        leoagent 保留作灰度回退,relay.py 继续服役
deps/  docs/  scripts/  原生依赖构建、文档、工具
```

## 当前 iOS 版本

- 版本/构建:`1.23.1 (93)`;Bundle ID `com.leoyuan.leophoneagent`
- 主对话框直达 Mac:「指挥一台 Mac」选机 + 选 CLI 即开聊;发送在会话建立
  期间自动排队,永不吞点击
- 会话接管:进入任意 Mac 先列进行中任务,一键接管(全量回放 + 实时跟随)
- Grok 模型接入:「从 Mac 借用登录」——手机不跑 OAuth,向 Mac 的
  `/v1/grok/token` 借自动续期的 access token(refresh 链由 Mac 独占)
- 更新机制:每次发版内置更新说明,首启弹「本次更新」卡(发版铁律见
  [CLAUDE.md](CLAUDE.md))

## 当前 Android 版本

- 开发版本：`1.0.0-alpha.1`，`minSdk 26`、`targetSdk 35`、仅 ARM64
- Standard 包名：`com.leoyuan.leophoneagent`
- Power 包名：`com.leoyuan.leophoneagent.power`
- 两个版本共享本机 Agent、Provider、Skills、MCP、Memory、PRoot 与浏览器底座；
  Power 高权限能力通过独立构建标志逐步接入
- 兼容既有 `minis://` 内部资源协议，同时新增 `leophoneagent://` 导航入口

## 构建

iOS(需 Xcode 26+,真机 ARM64):

```sh
git clone --recurse-submodules https://github.com/leoyb1010/LeoPhoneAgent.git
cd LeoPhoneAgent
./deps/build_ffmpeg.sh && ./deps/build_ish.sh && ./deps/prepare_alpine_rootfs.sh
open src/ios/LeoPhoneAgent.xcodeproj
```

Android（JDK 17、SDK 36、NDK r28+、ARM64）：

```sh
export JAVA_HOME=/path/to/jdk-17
export ANDROID_NDK_HOME="$HOME/Library/Android/sdk/ndk/28.0.13004108"
./deps/build_proot.sh
./scripts/prepare_android_sandbox.sh
cd src/android
./gradlew :app:assembleStandardDebug
./gradlew :app:assemblePowerDebug
```

生成的 PRoot、Alpine、Debug Skill 与 APK 都是可重建产物，不进入 Git。
完整要求与测试命令见 [BUILDING.md](BUILDING.md#android)。

Mac 桌面端已并入本仓 `src/mac/leocodebox/`,内部兼容名仍为 leocodebox,
界面品牌为 **LeoPhoneAgent · Mac**。源码、Issue 与版本说明以本仓为唯一
事实来源;`leocodebox-updates` 只保存自动更新的签名产物,不再作为源码仓。

```sh
cd src/mac/leocodebox
npm ci
npm run typecheck && npm run lint && npm test && npm run build
npm run desktop:dist:mac
```

旧版 `src/mac/leoagent/` 保留作协议灰度回退,`relay.py` 继续服务中继。
合并和迁移边界见
[REPOSITORY_MERGE_AND_READINESS_2026-08-11.md](docs/REPOSITORY_MERGE_AND_READINESS_2026-08-11.md)。

## 来源与许可

- 主仓库:GPLv3,fork 自 OpenMinis(基线
  [`9cf3a855`](https://github.com/OpenMinis/OpenMinis/commit/9cf3a855fecd27bb5735b84cacbd56852a3ab8dd),
  保留 `upstream` remote;升级流程见 [UPSTREAM_SYNC.md](docs/UPSTREAM_SYNC.md))。
- `src/mac/leocodebox/` 保留其 AGPL-3.0-or-later、NOTICE 与第三方归属;
  合并不改变该目录原有许可。
- 已移除的 `src/mac/LeoAgentDesktop/`(Cindy/Apache-2.0 改造)见 git 历史,
  其 NOTICE 随历史保留;未使用其商标。
- 第三方致谢与许可证文本:[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

分发修改后的二进制须按各自许可证提供对应源码并保留声明。LeoPhoneAgent /
LeoAgent 名称与图标仅标识本 fork。
