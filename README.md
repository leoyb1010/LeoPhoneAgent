# LeoBot

个人 AI Agent：iOS、Android、HarmonyOS 客户端与 Mac 运行时，通过配对中继连接；第二大脑由独立资料库服务提供数据。

[![iOS](https://img.shields.io/badge/iOS-1.90.0%20(200)-0A84FF.svg)](src/ios/Views/Settings/LeoReleaseNotesView.swift)
[![Android](https://img.shields.io/badge/Android-1.0.0--alpha.27-3DDC84.svg)](https://github.com/leoyb1010/LeoPhoneAgent/releases/tag/android-v1.0.0-alpha.27)
[![macOS source](https://img.shields.io/badge/macOS_source-1.20.0-7C3AED.svg)](src/mac/leophone/package.json)
[![HarmonyOS source](https://img.shields.io/badge/HarmonyOS_source-0.5.2-0A84FF.svg)](src/harmony/app/AppScope/app.json5)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)

版本徽标指工程源码。已安装版本、对应源码与尚在开发的修改分开记录，不以 main 的当前内容推断设备已更新。

## 开发 Agent 先读

- 唯一源码主仓：[leoyb1010/LeoPhoneAgent](https://github.com/leoyb1010/LeoPhoneAgent)，默认分支 main。
- 本机唯一权威开发入口：`~/leophone-mac` 的 `main`，四端在此集成和发版。旧副本、历史 worktree 与远端受控构建快照不是发版源码入口。
- 先读 [AGENTS.md](AGENTS.md) 和目标目录规则；先检查 git status，fetch origin 并核对 ahead/behind。仅落后且干净时 pull --ff-only；不得 reset、覆盖或删除未知改动。
- 有效遗留改动先保留提交，再按当前主线恢复；不要直接搬入过期工作树。每个功能单独提交。
- iOS：src/ios；Mac：src/mac/leophone（当前 1.x 主线）；Android：src/android；HarmonyOS：src/harmony。
- src/mac/leoagent/relay.py 仍是中继源码；旧桌面 leocodebox 仅留在 archive/leocodebox-2.2.13 标签中。
- Mac 代码先读其 AGENTS、相关 spec 与架构边界。Node/pnpm 以 mise.toml 和锁文件为准，不混用旧依赖或将环境错误当源码通过。
- 业务资料、凭据和私有地址只在用户现有安全配置中；不提交签名材料、真实 token、私密会话或个人基础设施清单。

## Android Agent 交接与发布铁律

Android 开发或发布前必须完整阅读 [Android 开发与发布规则](docs/ANDROID_RELEASE_RULES.md)。Standard/Power 共享源改动覆盖两种 flavor；固定签名指纹不可迁就机器调试证书，公开 APK 不可仅凭编译成功发布。

## 本轮已安装与开发状态

| 设备线 | 已安装个人版本 | 对应源码 |
| --- | --- | --- |
| iPhone Duo、iPhone 17 Pro Max、Apple Watch | 1.90.0 / 200 | 49c23ce7f 的 iOS 源码 |
| Mate XT2 | 0.5.2 / 100031 | 1295f60c3 的 HarmonyOS 源码 |

首批覆盖安装沿用原签名并保留数据。后续 main 可包含未再次装机的开发修改；功能、界面和性能由用户自测，不以源码审查、编译或版本回读替代。

旧 HarmonyOS 候选文档不代表最终构建状态。0.5.0 的原生构建、签名与 Mate XT2 安装事实见 [原交付记录](docs/harmony-ux-20261108/DELIVERY.md)。

## 架构与资料索引

- [工程文档入口](docs/PROJECT_INDEX.md)：当前契约、构建、交付和历史文档。
- [架构与边界](docs/ARCHITECTURE.md)：运行时所有者、配对中继、第二大脑和隐私通路。
- [更新记录](CHANGELOG.md)：各版本真实变化；工程内 release catalog 是首启更新说明来源。
- [Mac 主线说明](docs/mac-3.0/README.md) 与 [Mac 项目规则](src/mac/leophone/AGENTS.md)。
- [藏宝阁跨端历史计划](docs/TREASURY_CROSS_PLATFORM_UPGRADE_PLAN.md) 只作历史参考，不是当前开发目录或版本依据。

## 构建与个人安装

### iOS / Watch

使用 Xcode 27 或更新版本，按本机策略复用既有 ARM 模拟器；不自动下载运行时或创建克隆。原生依赖准备见 deps/ 下脚本及 BUILDING.md。

真机安装唯一入口：

```sh
./scripts/InstallIOSRelease.sh <设备UDID> ...
```

用户自行测试的安装模式：

```sh
LEO_IOS_INSTALL_ONLY=1 ./scripts/InstallIOSRelease.sh <设备UDID> ...
```

该模式仍校验版本/更新说明、编译与签名，再覆盖安装；明确跳过 CI 和性能评估，不表示测试通过。新增设备先使用其单设备 destination 登记；签名不匹配不得卸载或换钥掩盖。

### Mac

在 src/mac/leophone 内使用锁定依赖及 Node/pnpm。开发、生产构建与签名分发是不同阶段；构建命令以 package.json 为准。个人分发不自动创建公开 Release，运行中的用户任务不因升级被盲目中断。

### HarmonyOS

源码在 src/harmony/app；原生构建入口 src/harmony/scripts/build_hap.sh。可以使用同项目既有受控舞台复用未变化的原生生成依赖，但必须记录 canonical 源码 SHA、编译结果、签名链与 HAP 摘要，再按原签名覆盖安装。

### Android

构建约束与流程见 [完整规则](docs/ANDROID_RELEASE_RULES.md)。开发编译不等于签名发行；Standard 与 Power 不混淆权限或安装包身份。

## 发布与数据边界

- 每次实际安装的新版本更新工程版本及对应 release catalog，首启展示本版真实的“本次更新”。
- 编译、签名校验、安装、版本回读和用户功能验收分别记录，不互相冒充。
- 凭据沿用各平台现有机制；实际数据去向、同步和日志边界见 [统一隐私说明](docs/PRIVACY.md)。
- 第二大脑服务不属于此仓库；本仓只维护客户端和已确认契约。私有部署位置在本机维护记录，不写入公共默认值或日志。
- 本次按用户范围保留现有备份、数据库、同步冲突和持久缓存策略，不做资料迁移或批量清理。

## 来源与许可

本仓为 [OpenMinis](https://github.com/OpenMinis/OpenMinis) 的独立 GPLv3 fork，与上游官方产品无关、未获其背书。产品名沿用 LeoBot；仓库地址、Bundle ID 与数据目录可能保留历史名称。

[GPLv3 许可证](LICENSE) · [历史 README（本次文档收口前）](https://github.com/leoyb1010/LeoPhoneAgent/blob/1295f60c38d01ea71de8835f9a7f9ce82ef40cea/README.md)
