# leocodebox 1.49.4

品牌焕新 + 性能与体验升级的合并发布(纳入远端「branding / upgrade plan / perf & agent control」三组提交)。含 1.49.1–1.49.3 的全部修复(grok 一等接入、模型目录、档案弹窗层级、41 张新配图、Leoapi 改接口不生效)。

## 主要变化

**设计系统 / 品牌焕新**
- 1318 行的 `index.css` 拆成 `styles/{tokens,base,chat,settings,file-tree}.css`,建立设计 token 体系(success/warning/info 语义色、elevation 阴影、motion 时长、radius 圆角),并映射进 Tailwind 主题。拆分忠实,无规则/变量/keyframes/暗色覆盖丢失。
- 共享 UI 全量迁移到 token:卡片圆角、阴影、动效统一;新增弹窗进/出动画、PillBar 滑动指示器、语法高亮主题懒加载。
- 全局圆角小幅上调(rounded-md ~6→8px、rounded-lg 8→12px)—— 有意的视觉刷新。

**性能**
- 聊天消息列表引入 `virtua` 虚拟化(≥80 条分组时启用);流式热路径由「整体合并+排序」改为增量 append-patch + 线性双向归并,长会话更跟手。
- 前端拆包(markdown/katex/search/virtual-list 独立 chunk),katex 样式按需加载。

**Leoapi / Provider 运行时**
- 活跃节点环境逻辑重构为可复用的 `buildEffectiveSessionEnv()`;1.49.3 的「清掉 shell 继承旧 `ANTHROPIC_*` 再套活跃节点」保真保留(env 泄漏修复不回退)。
- 新增会话 pin、脱敏 transcript 导出端点;`CONTEXT_WINDOW` 环境猜测改为按模型元数据取上下文窗口;权限超时改为 `action_required` 通知;agent/claude 运行时统一走结构化日志。

**apiClient / 工具**
- 删除 `src/utils/api.js`,统一并入 `apiClient.ts`(`ApiError`/`authenticatedFetch`/`apiRequest` 同源,含更稳的错误信息解析);新增 `withViewTransition`(带 reduced-motion/降级回退)与 `startVisibleInterval`(页面隐藏时暂停的可见轮询)。

## 验证

- 门禁全绿:客户端/服务端 typecheck、ESLint 0 警告、生产构建通过。
- 自动测试 **366**(desktop 27 + client 70 + server 269),0 失败。
- 5 路并行审查(逐区域对抗式复核 286 文件合并):**0 blocker**;确认 Leoapi env 修复与档案弹窗层级(z-[10000] > 设置 z-[9999])均保真。
- 真机浏览器核对:App 渲染正常(设计 token 拆分后样式完整)。

> 已知次要项(不影响发布,后续清理):`styles/tokens.css` 里 `--radius-*` 有两处重复定义(后者生效、前者为死值);`CONTEXT_WINDOW` 覆盖已被模型元数据取代(如有部署依赖需知悉)。

## 下载校验

- DMG SHA-256:`13eea84a6320935a12c5cf995e3779fd352d76dabafa58ed08c3990bb83e0b95`
- ZIP SHA-256:`c4ac791126d436840897de9da673d87abc258e96690b8fc1b9cd7436483926ea`
- `latest-mac.yml` SHA-256:`0fede5656db946e40849c31b5c7adc94ea78000c0a7fa94379f868b05290d024`
