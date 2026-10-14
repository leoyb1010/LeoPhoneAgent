# 模型选择器:搜索、常用与最近使用(Model Picker)

模型多了以后(API Key 供应商 + ChatGPT / Copilot / OpenCode Go 账号模型),在 provider 二级菜单里逐个翻找很慢。
对齐 iOS LeoBot(`src/ios/Providers/ModelSearchScorer.swift`、`src/ios/Views/Providers/UnifiedModelPicker.swift`):
打开即可打字搜索,常用模型置顶,最近用过的模型一步可达。

## 覆盖范围

所有复用 `ModelConfigSelect` 的入口行为一致:Composer 模型菜单、闲时/自动化任务模型、Subagent 模型(内置与表单)、
工作流运行设置模型。分组仍由 `buildRegistryModelSelectGroups` 产出,item `value` 统一是
`encodeCustomModelValue(providerId, modelId)`,常用/最近按该值匹配。

## 交互规则

- 打开菜单时焦点在顶部搜索框;在菜单任意位置直接打字也会落到搜索框(type-to-filter)。
- 查询非空:所有 provider(含 `leadingItems`)的模型拍平,用评分器排序后单列展示;每行主文本为展示名,
  次级文本为 `provider · 模型 ID`(`font-mono`,subtle)。默认高亮第一项,`↑/↓` 移动,`Enter` 选中,
  鼠标悬停同步高亮。无结果时显示「没有匹配的模型」。
- 查询为空:顶部依次为「常用」(置顶,最多 8 个,按置顶顺序)和「最近使用」(最近 3 个实际发送过的不同模型,
  新的在前,已置顶的不重复出现),之后是原有 provider 分组。`↓` 在搜索框时进入快速区;快速区之后交给原有菜单的方向键焦点。
- `Esc`:查询非空时先清空查询;查询为空时关闭菜单。
- 行悬停显示星标按钮,点击置顶/取消置顶,不触发选中;已满 8 个时未置顶行的星标禁用并提示上限。
- 行高 `min-h-7`;能力徽标(视觉输入等)沿用已有数据,不新增请求。

## 评分器(`packages/ui/src/lib/modelSearchScorer.ts`,纯函数)

- 归一化:NFKD + 去组合附加符号 + 小写,得到大小写 / 变音符 / 全半角不敏感。
- 查询按空白拆词,每个词必须命中某个字段,否则不匹配;各词得分相加。
- 档位:前缀 400 > 词边界 300 > 子串 200 > 模糊(按序出现,词长 ≥ 3)100 − 间隙(最低 1)。
- 模型字段:模型 ID、展示名、基础展示名;服务商名称只做非模糊匹配且扣 50 分。
- 整个查询恰好等于模型 ID 或展示名 +100000。
- 稳定排序:分数降序,同分保持原顺序;空查询返回原列表。

## 状态所有者与持久化

| 状态 | 所有者 | 写入方 |
| --- | --- | --- |
| 搜索词、高亮项 | `ModelConfigSelect` 局部 state,关闭即重置 | 组件自身 |
| 常用 `modelPickerPinnedValues` | `AppSettings`(Setting Service,跨重启) | `useModelPickerQuickAccess().togglePinned`(星标) |
| 最近使用 `modelPickerRecentValues` | `AppSettings`(Setting Service,跨重启) | `SessionPane.handleSendText` 发送被接受(`sent`)后唯一一次写入 |

- 两个字段分开存,避免置顶与发送互相覆盖整对象。最近使用存最多 10 个(展示时过滤不可用后取 3 个)。
- 读写都走 `useSettings()` 的同一快照(按 Service 实例隔离,远程 workspace 跟随其 Environment);
  不新增 Zustand store,不在组件里缓存第二份。
- 最近使用只在发送被接受(非 blocked / 非待确认 / 非异常)后记录,模型取发送前冻结的 `submission.modelSelection`
  (与实际请求同一份,await 期间切模不影响);打开菜单、悬停、切换模型都不写。
- 纯逻辑(`togglePinnedModel` / `recordRecentModel` / `resolveQuickAccessItems`)在
  `packages/ui/src/lib/modelPickerQuickAccess.ts`,单测覆盖。

```
ConversationComposer.submit ─▶ SessionPane.handleSendText
   冻结 submission.modelSelection ─ dispatchSendText ─ "sent" ─▶ recordModelUsed(encode(providerId, modelId))
                                                     └─ settingService.update({ modelPickerRecentValues })
星标点击 ── togglePinned(value) ──────────────────▶ settingService.update({ modelPickerPinnedValues })
                                                     └─ syncAppSettings + refresh(其他窗口经 onSettingsChanged 刷新,只读不回写)
ModelConfigSelect(打开) ◀── settings 快照 ── resolveQuickAccessItems(groups, pinned, recent)
```

## 不可用模型

- 常用/最近中的值若不在当前分组(供应商被禁用、缺 Key、模型被删除)直接不展示,数据保留,恢复后自动重新出现。
- 被调用方 `isItemLocked` 锁定的项沿用现有禁用样式与原因提示。

## 验收

- `node --import tsx --test test/modelSearchScorer.test.ts test/modelPickerQuickAccess.test.ts`(packages/ui)。
- 打开 Composer 模型菜单直接输入 `opus` 回车即切换;输入全角 `ＧＰＴ` 与 `gpt` 结果一致。
- 置顶 / 发送后重启 App,常用与最近使用仍在;禁用对应供应商后它们从快速区消失。
