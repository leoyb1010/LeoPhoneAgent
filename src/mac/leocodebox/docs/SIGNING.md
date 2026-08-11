# macOS 代码签名与公证

让 leocodebox 能在别人的 Apple 芯片 Mac 上双击直接运行（不被 Gatekeeper 拦、不用敲 `xattr`），需要用 **Developer ID Application** 证书签名并经 Apple **公证**。

无签名环境变量时，`npm run desktop:dist:mac` 仍产出可自用的 adhoc DMG（行为不变）。

## 一次性准备

1. **加入 Apple Developer Program**（个人 99 美元/年）。
2. **创建 Developer ID Application 证书**（Xcode 不会自动建）：
   Xcode → Settings → Accounts → 选中团队 → **Manage Certificates** → 左下 `+` → **Developer ID Application**。
   验证：
   ```bash
   security find-identity -v -p codesigning | grep "Developer ID Application"
   ```
   记下完整名字，形如 `Developer ID Application: 你的名字 (TEAMID)`。
3. **存公证凭据到钥匙串**（密码只输入在你自己的终端，不进仓库、不经过任何工具）：
   ```bash
   xcrun notarytool store-credentials "leocodebox" \
     --apple-id "你的appleid@邮箱" \
     --team-id  "TEAMID" \
     --password "app专用密码"   # appleid.apple.com 生成
   ```

## 每次出正式版

```bash
export LEOCODEBOX_SIGN_IDENTITY="Developer ID Application: 你的名字 (TEAMID)"
npm run desktop:dist:mac:signed        # 用 Developer ID 签名并打包 DMG
npm run desktop:notarize:mac           # notarytool 公证 + stapler 钉章（用钥匙串 profile）
```

## 验证

```bash
VERSION="$(node -p "require('./package.json').version")"
TMP_ROOT="$(mktemp -d)"
ditto -x -k "release/desktop/leocodebox-${VERSION}-mac-arm64.zip" "$TMP_ROOT"
codesign -dv --verbose=4 "$TMP_ROOT/leocodebox.app"   # 应显示 Developer ID，非 adhoc
xcrun stapler validate "$TMP_ROOT/leocodebox.app"     # 更新 ZIP 内的 App 也应有票据
spctl -a -vvv --type execute "$TMP_ROOT/leocodebox.app" # 应 accepted / Notarized Developer ID
```

上述检查通过后，别人下载双击即可运行。`spctl --type install` 对 DMG 本身可能给出假失败，发布门禁以 DMG 的 stapler 校验和挂载后 App 的 Gatekeeper 结果为准。

## 相关文件

- `build/entitlements.mac.plist` — hardened runtime 下 Electron/子进程所需 entitlement。
- `scripts/release/prepare-desktop-app.js` — `resolveMacBuildConfig()` 在设了 `LEOCODEBOX_SIGN_IDENTITY` 时注入签名配置。
- `scripts/release/notarize-mac.sh` — 公证 DMG、分别为 DMG 与 App 钉章，并重建热更新 ZIP/元数据。
- `scripts/release/sign-macos-app.sh` — 逐个签名安装包中的 Mach-O、原生模块、Framework 与 Helper。
- `scripts/release/verify-macos-signatures.sh` — 对所有嵌套 Mach-O 执行 Developer ID、时间戳和 hardened runtime 校验。

## 为什么源码配置保持 `asar: false`

当前桌面构建有意使用 `asar: false`，并在外部发布脚本中完成 Developer ID 签名、公证和 stapler。PTY、SQLite 原生模块、Provider CLI 以及插件资源需要真实文件路径；在完成 ASAR A/B 测试并证明启动、原生模块、签名与更新链路均不退化前，不应仅为缩小文件数量而开启 ASAR。

`package.json` 中 `hardenedRuntime`/`notarize` 的基础值保持关闭也是有意设计：正式发布入口 `desktop:dist:mac:signed` 会通过 `prepare-desktop-app.js` 注入受控签名配置，随后由 `notarize-mac.sh` 执行公证。不要绕过这些脚本直接把未签名产物写入正式更新 feed。
