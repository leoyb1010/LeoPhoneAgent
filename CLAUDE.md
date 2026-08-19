
## 发版铁律(用户指令,长期生效)

**第一条,全端通用,不可绕过:每一次发版都必须在装机后跳出「本次更新」提示,
并且提示里写的就是这一版真正改了什么。** 版本号 bump 了却弹不出提示,或者弹出来
是上一版的内容,都算发版失败 —— 要退回去补,不能"下次再说"。

- iOS 每次安装到真机的发版,无论改动大小:必须 bump 版本号(MARKETING_VERSION 或 CURRENT_PROJECT_VERSION),在 `src/ios/Views/Settings/LeoReleaseNotesView.swift` 的 `LeoReleaseCatalog.releases` 最前加对应条目,保证首启弹出"本次更新"。
- Mac 桌面端(`src/mac/leocodebox/`):bump `package.json` 的 version,并在
  `src/components/version-upgrade/releaseNotes.ts` 的 `LEO_RELEASE_NOTES`
  **最前面**加一条。发版链上有自动闸门(`npm run verify:release-notes`,挂在
  `desktop:dist:mac:signed` 链首),漏写就构建不出来 —— 别去绕过它,补条目才是对的。
  详见 `src/mac/leocodebox/CLAUDE.md`。
- Android 每次公开 APK 必须遵守 README「Android Agent 交接与发布铁律」：递增 versionCode/versionName、双 flavor 门禁、固定 Alpha 签名指纹、上一可用版覆盖安装、Fold8 冷启动/Logcat、README/Release digest 一致，缺一不得上传。
