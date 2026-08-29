# LeoPhoneAgent

[![iOS](https://img.shields.io/badge/iOS-1.29.0%20(103)-0A84FF.svg)](src/ios/Views/Settings/LeoReleaseNotesView.swift)
[![Android](https://img.shields.io/badge/Android-1.0.0--alpha.21-3DDC84.svg)](https://github.com/leoyb1010/LeoPhoneAgent/releases/tag/android-v1.0.0-alpha.21)
[![macOS](https://img.shields.io/badge/macOS-1.78.0-7C3AED.svg)](src/mac/leocodebox/package.json)
[![HarmonyOS](https://img.shields.io/badge/HarmonyOS-0.3.0--alpha.17-D94B16.svg)](src/harmony/app/AppScope/app.json5)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)
[![Mobile](https://img.shields.io/badge/mobile-iOS%20%2B%20Android-black.svg)](#系统架构)

**个人 AI Agent：iPhone 与 Android 都能独立工作，三台 Mac 是“第二具身体”。**

手机端本身是一个完整的端上 Agent（模型接入、Linux 沙箱、浏览器自动化、
技能与记忆);同时通过自营中继,在任意网络(蜂窝/WiFi)远程指挥任意一台
Mac 上的编码 CLI(Claude Code / Codex / Cursor / Grok),支持断线续传、远程审批、
会话接管。Mac 侧另有一个完整的桌面端(Cindy 开源桌面的深度改造版)。

Android 端以 OpenMinis 的 Kotlin/Compose 共同历史为底座，提供 Standard
与 Power 两种构建；Power 版为 Accessibility、Shizuku 与受控系统操作预留
独立能力闸门，不改变 iPhone 独立运行或现有 Mac Relay 协议。

> 本仓库是 [OpenMinis](https://github.com/OpenMinis/OpenMinis) 的独立 GPLv3
> fork,与 OpenMinis 官方产品无关,亦未获其背书。

## 开发 Agent 先读

**任何 Codex、Cursor、Claude Code 或其他 Agent 继续开发前，必须先读完本节和
[「Android Agent 交接与发布铁律」](#android-agent-交接与发布铁律)。**

- 唯一源码主仓：`https://github.com/leoyb1010/LeoPhoneAgent`，默认分支 `main`。
- Android 主工程：`src/android/`；iOS：`src/ios/`；Mac 桌面端：
  `src/mac/leocodebox/`。`src/mac/leoagent/` 是协议兼容/灰度回退，不是 Android UI 工程。
  鸿蒙 7 交付计划：
  [`docs/superpowers/plans/2026-08-19-harmonyos7-delivery.md`](docs/superpowers/plans/2026-08-19-harmonyos7-delivery.md)；
  工程落地在 `src/harmony/`。当前船是 `0.3.0-alpha.17`，只走 `hdc install`。
  没有 Linux 沙箱，也不做无障碍跨应用。杀进程后审批不可用。
- Android 同时交付 Standard 和 Power；修改 `main` 公共源码后必须同时验证两个 flavor。
- 不得把「能编译」、「CI 是绿的」或「APK 已上传」当成可发布证据。
  可升级签名、覆盖安装、冷启动、发布附件哈希都必须单独校验。
- 任务开始先读 `git status`并获取最新 `origin/main`；未知本地改动默认属于用户，
  不得 `reset --hard`、覆盖或删除。

## HarmonyOS 0.3.0-alpha.17

个人 hdc 安装，不上应用市场。包名 `com.leoyuan.leophoneagent.harmony`。
没网也能听懂「打开手电筒」「记个待办」并直接做。家页最多三张主动卡，可在外观关掉。
设置能搜。强调色对齐青绿。竖屏单列，横屏/宽屏才左右分栏。

OpenAI / Anthropic / Gemini / xAI 登录和官方接口大陆直连通常不通，需要可访问境外的网络。OpenRouter 通常可达，Kimi 和多数国内兼容根可直连。登录被地区拦截时不再跳系统浏览器，停在本页中文说明并可复制链接。

```bash
bash src/harmony/scripts/verify_harmony_release_notes.sh
bash src/harmony/scripts/build_hap.sh
# 产物：/tmp/leo-harmony-app/entry/build/default/outputs/default/entry-default-unsigned.hap
# 在 DevEco 里对工程签一次名后再 hdc install。仓库路径含中文，hvigor 必须在 /tmp 舞台目录构建。
```

鸿蒙 NEXT 跑不了 Android 那份 PRoot。远程机器仍是第二个入口。Push 没配 AGC 时杀进程后仍收不到。

## 直接下载 Android APK

> 当前为个人 Alpha 预发布版，仅支持 ARM64。两个 APK 使用不同包名，可以在
> 同一台手机上同时安装。Power 版只有在用户完成产品内授权以及 Android
> 无障碍/Shizuku 系统授权后，才会开放更深的跨应用操控。

- [下载 Standard alpha.21](https://github.com/leoyb1010/LeoPhoneAgent/releases/download/android-v1.0.0-alpha.21/LeoPhoneAgent-Standard-1.0.0-alpha.21.apk)
- [下载 Power alpha.21](https://github.com/leoyb1010/LeoPhoneAgent/releases/download/android-v1.0.0-alpha.21/LeoPhoneAgent-Power-1.0.0-alpha.21.apk)
- [查看本次更新记录](CHANGELOG.md#t10-alpha21)
- [查看完整五轮审计与交付报告](docs/ANDROID_DELIVERY_1.0.0_ALPHA1.md)

SHA-256：

```text
Standard  e23638684fa1bb14c99db7dc6d3b8974938cdd0439cdf530e4b2f661f3f7706f
Power     5321469d3df839f187b901b59097aceaf67b82f36c27aa77123e671e69f9c016
```

本次公开附件使用显式开启的个人 Alpha 调试证书签名，不应作为应用商店的
正式升级证书链。正式分发前仍需换成长期托管的发行 keystore；因此从本次
Alpha 切换到正式版时可能需要先卸载旧包。APK 内已附 GPL、第三方许可、
隐私说明与源码提供说明。
个人 Alpha 升级链的证书 SHA-256 固定为
`f325bc65f4f6ba456938c7d88c96ad2ef418197d1204cfd2bd881aa145bf11df`；
发布前用 `scripts/verify_android_alpha_release.sh` 强制校验。

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
│  Pro     │ │ (cortex) │ │           │   claude/codex/cursor/grok 无头会话
└──────────┘ └──────────┘ └───────────┘   NDJSON 日志 + SSE 续传 + 审批
```

- **连接模型**:Mac 主动出站连中继(穿 NAT),手机走公网 HTTPS——两端在
  任意网络均可,手机无需 VPN/Tailscale 客户端/SSH。
- **协议**:自研 harness 协议(单调 seq 的 NDJSON 事件日志,SSE `?after=N`
  回放再跟随),断线不丢事件;审批带独立 `approval_id`,手机/手表均可应答。
- **CLI 方言**:Claude Code(stream-json)、Codex(app-server JSON-RPC)、
  Cursor Agent(one-shot stream-json)、Grok(`grok agent stdio`,ACP/Agent Client Protocol)。
- **Cursor 快捷配置**:在每台 Mac 上安装 Cursor CLI 后执行
  `cursor-agent login`；Android「我的 Mac」新任务里直接点「Cursor」即可运行。
  无头机也可向 leocodebox 进程安全注入 `CURSOR_API_KEY`。
- **安全**:一把 ≥16 字符密钥保护中继与全部端点(个人产品,单用户模型);
  Funnel 只挂中继路径;密钥自动清洗复制残渣(尾部 `%`/换行)。

## 仓库布局

```text
src/ios/                iOS 主 app(Swift/SwiftUI)+ Share/FileProvider/Widget/Watch
src/android/            Android 主 app(Kotlin/Compose)+ PRoot/Accessibility/Shizuku
src/harmony/            HarmonyOS 7 瘦控制面(ArkTS)：协议层 + DevEco 工程
src/mac/leocodebox/     LeoPhoneAgent · Mac:Electron 桌面工作台、CLI 管理、
                        本机服务、会话/技能/MCP 与跨设备控制
src/mac/leoagent/       Mac 常驻服务:server.py(harness 会话)、relay.py(中继)、
                        relay_client.py(出站注册)、harness.py(CLI 方言翻译)
                        ※ harness 面已由 leocodebox 1.63+ 接管(协议同构);
                        leoagent 保留作灰度回退,relay.py 继续服役
deps/  docs/  scripts/  原生依赖构建、文档、工具
```

## 当前 iOS 版本

- 版本/构建:`1.29.0 (103)`;Bundle ID `com.leoyuan.leophoneagent`
- iPhone / iPad 本机动作：剪贴板读写和设备信息直接走系统能力，写入后读回核对；
  支持 Foundation Models 的设备用结构化生成整理收藏与语音任务
- iPad 工作区：分屏、台前调度和窗口缩放按正文/侧栏实际可用空间切换单双栏，
  保留多窗口、拖放附件与外接键盘快捷键
- 主对话框直达 Mac:「指挥一台 Mac」选机 + 选 CLI 即开聊;发送在会话建立
  期间自动排队,永不吞点击
- 会话接管:进入任意 Mac 先列进行中任务,一键接管(全量回放 + 实时跟随)
- Grok 模型接入:「从 Mac 借用登录」——手机不跑 OAuth,向 Mac 的
  `/v1/grok/token` 借自动续期的 access token(refresh 链由 Mac 独占)
- 更新机制:每次发版内置更新说明,首启弹「本次更新」卡(发版铁律见
  [CLAUDE.md](CLAUDE.md))

## 当前 Android 版本

- 开发/发布版本：`1.0.0-alpha.21`（versionCode `100021`），`minSdk 26`、`targetSdk 35`、`compileSdk 36`、仅 ARM64。
- Standard 包名：`com.leoyuan.leophoneagent`
- Power 包名：`com.leoyuan.leophoneagent.power`
- 两个版本共享本机 Agent、Provider、Skills、MCP、Memory、PRoot 与浏览器底座；
  Power 高权限能力通过独立构建标志和逐次危险命令确认隔离
- Standard 不再声明所有文件、无障碍、Shizuku 或应用列表高权限；完整目录挂载和
  跨应用操控只在 Power 出现。两版的用户发起 Agent 前台服务都使用真实的
  `dataSync|specialUse` 类型，不再伪装成媒体播放
- 系统表面：可替换默认数字助手、快捷设置磁贴（新对话 / 语音）、任务状态桌面小组件、
  App Shortcuts、通知继续/暂停/打开、WorkManager 计划任务补队列、悬浮窗、
  Android 16 Live Updates 状态胶囊、前台服务、忽略电池优化、预测性返回、16KB 页对齐
- 进程被杀后遗留任务变成「等待用户继续」，点了才恢复；助手 / 磁贴 / 小组件 / 通知 / 开机走同一条深链路由
- 兼容既有 `minis://` 内部资源协议，同时新增 `leophoneagent://` 导航入口
- Fold8 宽折叠适配：1080×1728 封面单栏、1768×2208 展开双栏，并通过
  200% 系统字体可用性验证
- 简体中文设置、列表、按钮、弹窗与主操作 TalkBack 标签已资源化，并加入
  中文资源完整性与设置页英文硬编码构建门禁
- Claude Code、Codex CLI、Grok Build 与 Cursor CLI 可在本机 Alpine ARM64
  沙箱安装、更新，也可直接从聊天模型选择器作为本机执行引擎运行，不必进入终端。
  连接明确分为「CLI 官方账号」与「Leo 模型」：Claude/Codex/Grok 可用兼容 API-key Provider，
  Cursor 只走官方账号；四家授权链接均在 App 内直接打开。Prompt 走会话私有临时文件，
  匹配供应商的 API Key 只通过单轮瞬时环境传递；
  OAuth/订阅令牌不会导出。成功写出的网页、文档、表格、PDF 与媒体会显示交付物卡片。
- 远程机器工作台使用 `after=seq` 的 SSE 回放 + 实时跟随；网络切换后续传输出、
  完成状态与审批请求，不再依赖手动刷新。

## Android Agent 交接与发布铁律

### 1. 开工前确认仓库

每次任务都从仓库根目录执行：

```sh
git status --short --branch
git remote -v
git fetch --prune --tags origin
git rev-list --left-right --count HEAD...origin/main
git submodule update --init --recursive
```

- 工作树干净且只是落后时，用 `git pull --ff-only origin main`。
- 有未提交内容时先识别归属，不自动 stash、删除或覆盖。
- 不从 ZIP、历史目录或另一个 leocodebox 仓库发布 Android APK。

### 2. 工程边界

| 范围 | 位置 | 硬约束 |
|---|---|---|
| Android 公共能力 | `src/android/app/src/main/` | Standard/Power 都会编译进去 |
| Standard 差异 | `src/android/app/src/standard/` | 不得引入 Power 高权限承诺 |
| Power 差异 | `src/android/app/src/power/` | Accessibility/Shizuku 继续受系统授权、产品授权和危险操作确认保护 |
| Android 版本/签名 | `src/android/app/build.gradle.kts` | 每个公开 APK 必须新 `versionCode` 和 `versionName` |
| Mac 主 harness | `src/mac/leocodebox/` | 改跨端协议时同时验证 Android 调用方 |
| Mac 灰度回退 | `src/mac/leoagent/` | 不要把新主实现误写到这里 |

Fold8 是 Android 主验收设备：封面屏 `1080×1728`、展开屏 `1768×2208`，
必须覆盖折叠切换、草稿/会话保留和 200% 字体。没有实际设备或模拟器证据时，
只能报告「代码/编译已验证」，不得声称 UI 或折叠适配已验收。

### 3. 个人 Alpha 签名链不可更换

当前 alpha.1–alpha.3、alpha.5–alpha.12 的可升级证书 SHA-256 是：

```text
f325bc65f4f6ba456938c7d88c96ad2ef418197d1204cfd2bd881aa145bf11df
```

alpha.4 **已损坏，不得继续使用或作为升级基线**：它由另一把调试密钥签名，
从 alpha.3 安装会返回 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。

- 不得在新电脑/新 CI 上用自动生成的 `debug.keystore` 发布 APK。
- 不得把 keystore、密码或 base64 密钥提交到 Git、Issue、日志或 Release。
- 同一台发布 Mac 可显式使用 `-Pleophone.allowDebugReleaseSigning=true`
  生成个人 Alpha；这不是应用商店生产签名。
- 如果 `scripts/verify_android_alpha_release.sh` 报证书不匹配，**立即停止发布**。
  不能更换期望指纹来“让检查通过”。

### 4. 开发闭环

1. 先复现真实问题，记录影响 Standard、Power 还是两者。
2. 复用现有 Kotlin/Compose/Room/DataStore 结构，修共享根因，不只补报错界面。
3. 修改中文界面时同步 `values`、`values-zh`、`values-zh-rTW`，包括 TalkBack `contentDescription`。
4. 修高权限能力时保持 Standard 组件关闭，Power 也必须通过系统和产品两道权限门。
5. 先跑触发路径的定向测试，再跑双 flavor 完整门禁。

### 5. 唯一允许的个人 Alpha 发布顺序

1. 递增 `src/android/app/build.gradle.kts` 的 `versionCode` 和 `versionName`。
2. 先写 `CHANGELOG.md` 的根因、可见改动、验证与边界，再更新 README 版本/链接。
3. 在同一 checkout、同一次源码状态运行：

```sh
cd src/android
./gradlew --no-daemon \
  :app:verifyChineseResources \
  :app:verifyChineseSettingsStrings \
  :app:testStandardDebugUnitTest \
  :app:testPowerDebugUnitTest \
  :app:lintStandardRelease \
  :app:lintPowerRelease \
  :app:assembleStandardRelease \
  :app:assemblePowerRelease \
  -Pleophone.allowDebugReleaseSigning=true
cd ../..
```

4. **不重新构建，不从其他机器混入附件。**对刚生成的两个 APK 运行：

```sh
ANDROID_SDK_ROOT=/path/to/Android/sdk \
  scripts/verify_android_alpha_release.sh \
  src/android/app/build/outputs/apk/standard/release/app-standard-release.apk \
  src/android/app/build/outputs/apk/power/release/app-power-release.apk
```

5. 在 Fold8 API 35 模拟器或真机上先安装「上一个可用版」，再用 `adb install -r`
   分别覆盖 Standard 和 Power。必须看到 `Success`。
6. 分别冷启动两包，再走一次系统助手入口：

```sh
pkg=com.leoyuan.leophoneagent
component="$(adb shell cmd package resolve-activity --brief "$pkg" | tr -d '\r' | tail -1)"
adb shell am force-stop "$pkg"
adb shell am start -W -n "$component"
adb shell am force-stop "$pkg"
adb shell am start -W -a android.intent.action.ASSIST -p "$pkg"
adb shell pidof "$pkg"
adb logcat -d | rg 'FATAL EXCEPTION|AndroidRuntime'
```

对 `com.leoyuan.leophoneagent.power` 重复。预期是安装 `Success`、启动 `Status: ok`、
存在 PID、没有本 App 的 `FATAL EXCEPTION`。

7. 计算这两个已验收 APK 的 SHA-256 并写回 README。上传后对比 GitHub Release
   `assets[].digest`；文档、本地文件、远程附件必须三者一致。
8. 检查 `git diff --check` 和 `git status`，只提交本次内容并推送 `main`；
   从该提交创建 `android-v<version>` tag 和 pre-release，附件固定命名为
   `LeoPhoneAgent-Standard-<version>.apk` 和 `LeoPhoneAgent-Power-<version>.apk`。
   不覆盖旧 tag，不静默替换同版本 APK。
9. 复核远端 `main` SHA、tag SHA、附件名称/大小/digest 和 CI。CI 没有同一把
   受保护密钥时，只能证明源码可编译，不能证明 APK 可覆盖升级。

### 6. 版本状态和完成定义

| 版本 | 状态 | 处理 |
|---|---|---|
| alpha.21 | 当前公开附件 | 本机动作回执、产物格式、权限隔离、减少动态效果与 Fold8 200% 字体修正 |
| alpha.20 | 上一公开附件 | 打开其他 App 后继续操控；悬浮窗默认开；Power 无障碍默认放行 |
| alpha.19 | 上一公开附件 | T7 手电筒/待办快路径 + 家页主动卡 |
| alpha.18 | 上一公开附件 | T6 断线续上 / 短码入列 / 远程会话进列表 |
| alpha.17 | 上一公开附件 | Fold8 API 35 模拟器 alpha.16→17 覆盖安装已过；真机由用户自装 |
| alpha.16 | 上一公开附件 | Fold8 API 35 模拟器覆盖安装已过 |
| alpha.15 | 上一公开附件 | Fold8 API 35 模拟器覆盖安装已过 |
| alpha.13 | 旧可用版 | 可直接升级到 alpha.15 / 16 |
| alpha.11 | 旧版 | 可直接升级到 alpha.13 |
| alpha.10 | 旧版 | 可直接升级到 alpha.13 |
| alpha.9 | 旧版 | 可直接升级到 alpha.13 |
| alpha.7 | 旧版 | 可直接升级到 alpha.9 |
| alpha.6 | 旧版 | 可直接升级到 alpha.9 |
| alpha.4 | **损坏/禁用** | 签名链错误，不得作为测试或发布基线 |
| alpha.3 | 旧版 | 存在系统助手闪退，只用于验证升级链 |

只有代码/文档/版本一致、双 flavor 门禁通过、签名正确、覆盖安装通过、
Fold8 冷启动与 Logcat 通过、远端 main/tag/APK 指向同一源码状态、
GitHub 附件 digest 与 README SHA-256 一致，才能声称 Android 发布完成。

## 构建

iOS(需 Xcode 26+,真机 ARM64):

```sh
git clone --recurse-submodules https://github.com/leoyb1010/LeoPhoneAgent.git
cd LeoPhoneAgent
./deps/build_ffmpeg.sh && ./deps/build_ish.sh && ./deps/prepare_alpine_rootfs.sh
open src/ios/LeoPhoneAgent.xcodeproj
```

Android（JDK 17、SDK 36、NDK 27.0.12077973、ARM64）：

```sh
export JAVA_HOME=/path/to/jdk-17
export ANDROID_NDK_HOME="$HOME/Library/Android/sdk/ndk/27.0.12077973"
./deps/build_proot.sh
./scripts/prepare_android_sandbox.sh
cd src/android
./gradlew :app:assembleStandardDebug
./gradlew :app:assemblePowerDebug
```

生成与本次附件相同类型的个人 Alpha Release（显式调试证书）及完整门禁：

```sh
./gradlew \
  :app:verifyChineseResources \
  :app:verifyChineseSettingsStrings \
  :app:testStandardDebugUnitTest \
  :app:testPowerDebugUnitTest \
  :app:lintStandardRelease \
  :app:lintPowerRelease \
  :app:assembleStandardRelease \
  :app:assemblePowerRelease \
  -Pleophone.allowDebugReleaseSigning=true
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
