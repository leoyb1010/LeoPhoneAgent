
## 发版铁律(用户指令,长期生效)

**第一条,全端通用,不可绕过:每一次发版都必须在装机后跳出「本次更新」提示,
并且提示里写的就是这一版真正改了什么。** 版本号 bump 了却弹不出提示,或者弹出来
是上一版的内容,都算发版失败 —— 要退回去补,不能"下次再说"。

- iOS 每次安装到真机的发版,无论改动大小:必须 bump 版本号(MARKETING_VERSION 或
  CURRENT_PROJECT_VERSION),在 `src/ios/Views/Settings/LeoReleaseNotesView.swift` 的
  `LeoReleaseCatalog.releases` 最前加对应条目,保证首启弹出"本次更新"。
  **装机走 `./scripts/InstallIOSRelease.sh`(唯一入口),闸门焊在第一步,漏写记录就装不进去。**
  不要再手敲 xcodebuild 直装 —— 那条路绕过闸门。
- Mac 桌面端(`src/mac/leocodebox/`):bump `package.json` 的 version,并在
  `src/components/version-upgrade/releaseNotes.ts` 的 `LEO_RELEASE_NOTES`
  **最前面**加一条。发版链上有自动闸门(`npm run verify:release-notes`,挂在
  `desktop:dist:mac:signed` 链首),漏写就构建不出来 —— 别去绕过它,补条目才是对的。
  详见 `src/mac/leocodebox/CLAUDE.md`。
- Android 每次公开 APK 必须遵守 README「Android Agent 交接与发布铁律」：递增
  versionCode/versionName、双 flavor 门禁、固定 Alpha 签名指纹、上一可用版覆盖安装、
  Fold8 冷启动/Logcat、README/Release digest 一致，缺一不得上传。
  **改 versionName 的同时必须重写 `values*/strings.xml` 的 `whats_new_current`,
  并把 `whats_new_version` 版本戳同步过来** —— `WhatsNewGateTest` 会比对这两个值,
  对不上就红。

### 「弹出」和「记录」是两件事,都必须落地

- **记录**:代码里那一版的更新条目(iOS 的 `releases`、Mac 的 `LEO_RELEASE_NOTES`、
  Android 的 `whats_new_current`)。它是发版内容的唯一事实来源。
- **弹出**:装机后首启真的把它显示出来。版本号没往前走就不会弹 —— 这是对的,
  同版本重装不该重复打扰;但也意味着**"没看到弹窗"要先查版本有没有真的升上去**,
  别一上来就以为是文案漏写。

### 闸门必须长在真实发版路径上

写了闸门不等于有闸门。`IOSReleaseReadinessAudit.sh` 长期只挂在
`.github/workflows/ios-tests.yml`,而真实发版是本地 `xcodebuild` 直装真机 ——
闸门存在,却不在实际走的那条路上,一次都没挡过。同期它通篇用 `rg`,本机
`/bin/sh` 的 PATH 里没有 rg,本地跑直接 127;CI 里有 `brew install ripgrep`
所以一直显绿,进一步维持了"有闸门"的错觉。

定闸门时按这三条自查:
1. 它跑在我**真正会执行**的那条命令链上吗?(不是"应该跑"的那条)
2. 它在**开发者本机**能跑起来吗?(不依赖只有 CI 才装的工具)
3. 我**反向验证**过它会红吗?(故意破坏一次,确认拦得住,再还原)

第 3 条尤其别省:只验证"改完是绿的"证明不了闸门有效 —— 空检查也永远是绿的。

