
## 发版铁律(用户指令,长期生效)

每次改动装到机器上,无论大小,都必须:
1. bump `package.json` 的 version
2. 在 `src/components/version-upgrade/releaseNotes.ts` 的 `LEO_RELEASE_NOTES`
   最前面加一条(版本、日期、这次改了什么)
3. 确认版本号注入生效(vite define → `import.meta.env.VITE_APP_VERSION`),
   否则启动弹卡不会触发

不要依赖 GitHub Release 提供更新说明 —— 内部迭代不发 release,那条路
永远是空的,等于"更新了但不知道更新了什么"。

## 界面风格(用户指令)

简约优先:少图标、少插画、少色块。信息密度 > 装饰。新页面默认
"一行一个对象 + 一个状态点 + 可读的字",不要仪表盘式的图形堆叠。
