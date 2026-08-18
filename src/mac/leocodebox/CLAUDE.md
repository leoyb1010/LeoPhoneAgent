
## 发版铁律(用户指令,长期生效)

**每一次发版都必须在装机后跳出「本次更新」,内容就是这一版真正改了什么。**
弹不出来、或弹出上一版的内容,都算发版失败。

每次改动装到机器上,无论大小,都必须:
1. bump `package.json` 的 version
2. 在 `src/components/version-upgrade/releaseNotes.ts` 的 `LEO_RELEASE_NOTES`
   最前面加一条(版本、日期、这次改了什么)
3. 确认版本号注入生效(vite define → `import.meta.env.VITE_APP_VERSION`),
   否则启动弹卡不会触发

第 1、2 条有自动闸门兜底:`npm run verify:release-notes` 挂在
`desktop:dist:mac:signed` 链首,版本对不上更新说明就直接构建失败。
**闸门是拿来挡自己的 —— 挂了就去补条目,不要删测试、不要绕过链路。**

血的教训:1.68.0 版本号 bump 了、也写了 `docs/RELEASE-1.68.0.md`,唯独漏了
`LEO_RELEASE_NOTES`,装机后弹不出更新。当时 `currentReleaseNote()` 还会
fallback 到上一条,把"漏写"伪装成"弹得好好的"。现在缺条目会明说缺失,
闸门也会在发版前挡住 —— 铁律靠人记就是记不住,得让它挡在路上。

不要依赖 GitHub Release 提供更新说明 —— 内部迭代不发 release,那条路
永远是空的,等于"更新了但不知道更新了什么"。

## 界面风格(用户指令)

简约优先:少图标、少插画、少色块。信息密度 > 装饰。新页面默认
"一行一个对象 + 一个状态点 + 可读的字",不要仪表盘式的图形堆叠。
