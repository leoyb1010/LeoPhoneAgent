# leocodebox 1.47.0

「瘦身与丝滑」——把安装包实打实地减小,并补齐 reduce-motion 支持仅剩的空白。只做低风险、可验证的优化;明确不碰会破坏离线首启的 Chromium 按需下载。全程门禁全绿 + 真机验证。

## 瘦身(可测量)

- **依赖剪枝 ~65MB**:29 个纯前端库(lucide-react、react-syntax-highlighter、katex、@xterm、@codemirror、@uiw/react-codemirror、dompurify、cmdk 等)从 `dependencies` 移到 `devDependencies`。它们早已被 Vite 编译进 `dist/`,Node 服务端与 Electron 主进程零引用(逐一核实)。electron-builder 按「生产依赖树」游走打包——被某个生产依赖间接依赖的库仍会保留,所以剪枝只会丢真正没人引用的前端库,运行时不可能缺模块。
- **视觉资源去重 ~31MB**:`public/visuals` 与 `dist/visuals` 内容重复(Vite 把 `public/*` 拷进 `dist/`,服务端两处都能 serve)。打包时排除 `public/visuals` 中 6 个 HTTP 冗余子目录,只保留 `brand/`(启动闪屏按文件路径读取)。
- **图标重编码 ~1.4MB**:`logo-32.png` / `favicon.png` 原是 1024×1024 的 716K 巨图,实际只渲染 28px。重编码到 128px,各降到 13K。

## 丝滑

- **reduce-motion 补齐**:全局 CSS 早已让所有过渡/动画在 reduce-motion 下失效,唯一漏网的是 JS 参数式平滑滚动(`scrollIntoView({behavior:'smooth'})`)——CSS 覆盖不到。新增 `utils/motion.ts`,把 3 处平滑滚动按偏好降级为瞬时。

## 刻意没做的(有据,不臃肿)

- **Chromium 按需下载**:那 206MB 是内置的离线浏览器运行时,砍掉能让 DMG 近乎减半,但会破坏「装完即用、离线可用」的内置浏览器首启体验,风险太高,不做。
- **长列表虚拟化**:聊天消息(末 100 条窗口化 + 分页)、会话列表(分页)、文件树(深度上限)现有机制已覆盖,唯一无界渲染是用户主动「加载全部消息」且已有警示。不为假想问题引入侵入式改造。
- **重建 onboarding**:两步首启向导 + 完成标记 + 接口已存在,不另起炉灶。

## 验证

- ESLint 0 警告,客户端与服务端 TypeScript 检查通过,生产构建通过。
- 自动测试:desktop 27、client 65、server 241,共 333 项通过。
- 真机验证:重新签名/公证/装机。打包后核对——被剪枝的 29 个前端库确实从随包 node_modules 移除,服务端库(express/better-sqlite3/react/playwright-core 等)完整保留;`public/visuals` 仅剩启动闪屏所需的 `brand/`,`dist/visuals` 全量在位。启动后 `/health` 正常返回 1.47.0,客户端 `index.html` 与主 JS 包(含被剪枝库的编译产物)HTTP 200 正常加载,去重后的视觉资源仍从 `dist/` 正常 serve——证明依赖剪枝与资源去重未伤及运行时。
- DMG 314MB → 268MB(−46MB / −15%);热更新 zip 339MB → 284MB。

## 下载校验

- DMG SHA-256:`67dc9f9dc222fafd151e8ab93843c16da0f020c4729eb66b13e74ebfd7488953`
- ZIP SHA-256:`372628070aa601c15045ba949d9ae20653cbc4f6d442eefe7aeb846812710520`
- `latest-mac.yml` SHA-256:`6eb163a5156f3c65a553a245c45c5a5b78ca2ffb22d2510a401ea72b805c94d7`
