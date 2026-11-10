# Android 开发与发布规则

以下命令均从权威仓库根目录执行。此文件由原 README 完整规则迁入；不改变签名、升级及权限边界。

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
| 当前 Mac Host/runtime | `src/mac/leophone/` | 改跨端协议时同时验证 Android 调用方 |
| Mac 中继及灰度回退 | `src/mac/leoagent/` | relay.py 仍在服务；不要把新桌面主实现误写到这里 |

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
| alpha.27 | 当前公开附件 | 会话批量导出、设置组件统一、反馈归属修正与三轮审计修复 |
| alpha.26 | 上一公开附件 | Grok 实时模型目录、自然语言系统动作、中断恢复、长粘贴和受限设置修复 |
| alpha.25 | 上一公开附件 | 执行凭证、自动安全更新、藏宝阁筛选/空状态和 Fold8 200% 字体优化 |
| alpha.24 | 上一公开附件 | 藏宝阁三端可调用知识库、系统捕获、按需正文/附件、Range 续传与 Fold8 完整门禁 |
| alpha.23 | 上一公开附件 | 恢复 OpenMinis Grok OAuth/完整目录，Fold8 更新弹窗与双 flavor 构建稳定性修复 |
| alpha.22 | 上一公开附件 | 出行双写、无障碍快照与省电恢复；Grok CLI 代理改动已在 alpha.23 回退 |
| alpha.21 | 上一公开附件 | 本机动作回执、产物格式、权限隔离、减少动态效果与 Fold8 200% 字体修正 |
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
