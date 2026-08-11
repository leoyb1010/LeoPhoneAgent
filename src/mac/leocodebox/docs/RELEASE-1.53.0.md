# leocodebox 1.53.0 — 驾驶舱增强

在 1.52.x 的首页驾驶舱基础上继续增强:新增项目总览卡、接通运行中会话的真实数据,并做了一轮卡片视觉与动效打磨。向后兼容,无新增网络面。

## 多了什么
- **项目总览卡**(新增 `ProjectsOverviewCard`):按项目展示各 Agent 会话数、收藏项目优先,读 `/api/projects`
- **运行中会话接真数据**:`RunningSessionsCard` 读 `/api/providers/sessions/running`,不再是占位
- **卡片打磨**:Agent 网格/用量中心/Claude 窗口/Hero 的悬停态、阴影阶梯与动效收敛;新增共享 `format.ts` 数字/时间格式化
- i18n:补 en / zh-CN 对应文案

## 验证
- 门禁全绿:typecheck 0、ESLint 0、client 71/71、server 299/299、生产构建通过
- 新接的两个端点已用本机 token 实测返回真实数据、字段与卡片一致(`/api/projects`、`/api/providers/sessions/running`)
- 原生模块 ABI 复核:better-sqlite3 在 Electron 运行时正常加载

## 下载校验
- DMG SHA-256:`b9bf10f828a0cd89b7e2dc44dc2aad416ecb5212808f300334394a0242af6376`
- ZIP SHA-256:`7c0c0514200cc5719ea75f77f0df985024091847225dab54b967181c38e277a4`
- `latest-mac.yml` SHA-256:`6b1286dacb91ba3cdcfd4733d2c151ddf6a5ec29f603932b4b54b98c54e537ac`
