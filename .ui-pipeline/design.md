# Design Direction

## Direction decision

- Chosen direction: “捕获入口轻，工作台信息密度随宽度增长”。保存动作不要求先填写分类；进入藏宝阁后再按处理/阅读状态搜索、筛选、阅读、定位高亮和批注。
- Existing authority: Android Material 3、iOS SwiftUI 列表/系统拖放、Mac leocodebox token 与卡片体系。

## Originality contract

- Visitor mode: Operate
- Product truth: 收藏不是聊天附件的副本，而是本机可搜索、可被 Agent 受控调用的个人资产。
- Concept spine: 先收下 → 显示处理状态 → 找回 → 打开/批注/交给 Agent。
- First-read object: 搜索框和内容列表；主要动作是“收进藏宝阁”。
- Spatial thesis: 小屏单栏详情替换列表；600dp 双栏；840dp 筛选/列表/详情三栏。
- Material strategy: 只用仓库已有 Compose/SwiftUI/React 组件和 Material/SF Symbol 图标，不新增图片或 UI 依赖。
- Anti-defaults: 不做无限目录树、假按钮、首页 AI 推荐瀑布流或桌面 UI 强塞到手机。

## System

- Typography: 继承平台动态字体；顶栏使用图标动作减少 200% 字体拥挤。
- Color: 仅失败/部分处理使用 error；普通 queued/ready 使用主题 surface 和文字层级。
- Grid: 8dp 基线；列表 12dp 水平间距；详情 18dp；触控动作由原生 Button/IconButton/Checkbox 保证。
- Shape: 继承 Material 3 和 leocodebox 现有圆角/边框。

## Composition

- Android compact: 搜索/筛选 → 列表；点开后进入独立详情，系统返回恢复列表状态。
- Android medium: 380dp 列表 + 弹性详情。
- Android expanded: 190dp 筛选 rail + 380dp 列表 + 弹性详情。
- iPad: 现有收藏列表接受系统 URL/String drop；文件继续走统一 importer。
- Mac: 同步范围 → 捕获区 → 离线/陈旧状态 → 搜索 → Mac/手机混合结果卡片 → 按需正文/附件与 Agent 引用。

## State matrix

| Surface | Empty | Processing | Partial/failed | Offline/stale | Responsive |
|---|---|---|---|---|---|
| Android list | 引导从分享或页面保存 | 状态标签 | 错误标签与详情重试 | 本地能力不受影响 | 1/2/3 栏 |
| Android detail | 选择提示 | 正文/附件可先读 | 原因码、重试 | 本地附件可打开 | 小屏替换/宽屏并列 |
| Share receiver | 无内容提示 | 原始复制后结束 | 失败 toast，暂存定向清理 | 链接仍先落库 | 系统对话框 |
| Mac workspace | 捕获提示 | 保存中禁用 | 本机错误单独显示 | 手机旧内容保留并标陈旧；可切仅本机 | 窄窗两段、宽窗三栏 |

## Motion budget

- 使用原生导航、列表和对话框过渡；状态不依赖动画表达。
- 未增加持续 shimmer、呼吸或后台动画；遵循系统 Reduce Motion。
- 超长正文只向交互式阅读控件提供有界窗口；PDF/OCR/索引均在后台任务完成，避免用动画掩盖主线程阻塞。
