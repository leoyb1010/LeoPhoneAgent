# 藏宝阁 Phase 0 交付证据

日期：2026-08-30
基线：`main` / `7692383977695e58bd1159e8aa60c95d92a9b9cc`

## 完成范围

- iOS 笔记交给 Agent 时从 `bodyFile` / `NoteBodyStore` 读取正文，不再发送空 `item.value`。
- 链接、文本、笔记、文件统一生成有来源、条目 ID、正文状态和截断标记的结构化上下文。
- Treasury 资料与用户指令分字段进入聊天；资料在模型消息中明确标记为不可信数据。
- 收藏页支持最多 20 条多选并一次交给 Agent；文件继续通过受控附件管道传递。
- 新增本机 `treasury_search`、`treasury_get` Agent 工具及工具状态/历史展示。
- `treasury_search` 返回紧凑结果、来源、命中片段、分数和命中字段。
- `treasury_get` 支持多 ID、正文/批注开关、单条字符上限、缺失 ID、正文状态和附件相对引用。
- FTS 补齐中文 1/2 字短词回退、英文大小写、字面 `%/_`、晚位置命中片段和按 ID 正文读取。
- 旧 `items.json` 和旧 `PendingShare` JSON 保持向后兼容。

## 三轮审计与修复

1. 正确性与提示注入审计：修复最低预算下上下文可能超限、XML 属性转义扩张、短词片段不含命中位置、FTS 参数绑定错误。
2. 文件与缓冲安全审计：拒绝 `../`、斜杠和反斜杠附件名；附件工具结果只返回相对受控引用；连续分享上下文限制为 50,000 字符并去重，指令限制为 8,000 字符。
3. 契约与回归审计：补齐工具结果闭合标签转义、文件缺失状态、过滤器组合、英文大小写、20 条最低预算和旧数据解码测试。

## 自动化验证

以下命令在 iPhone 17 Pro / iOS 26.5 Simulator 上实际执行：

```bash
xcodebuild -project src/ios/LeoPhoneAgent.xcodeproj \
  -scheme MinisLogicTests \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -onlyUsePackageVersionsFromResolvedFile \
  -skipPackageUpdates \
  -packageAuthorizationProvider netrc \
  -only-testing:MinisTests/TreasuryPhase0Tests test
```

结果：16/16 Treasury Phase 0 测试通过。

```bash
xcodebuild -quiet -project src/ios/LeoPhoneAgent.xcodeproj \
  -scheme MinisLogicTests \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -onlyUsePackageVersionsFromResolvedFile \
  -skipPackageUpdates \
  -packageAuthorizationProvider netrc test
```

结果：287/287 测试通过，0 failed，0 skipped。

```bash
xcodebuild -quiet -project src/ios/LeoPhoneAgent.xcodeproj \
  -target MinisShare -configuration Debug -sdk iphonesimulator -arch arm64 \
  -onlyUsePackageVersionsFromResolvedFile -skipPackageUpdates \
  -packageAuthorizationProvider netrc CODE_SIGNING_ALLOWED=NO build
```

结果：Share Extension 目标编译成功。

## 当前环境门禁

- 主 App Scheme 需要 watchOS 26.5，本机未安装该平台。
- 临时从本机构建图排除 Watch 后，主 App 继续被缺失的 `deps/ish` 内容阻塞：锁定提交 `8d53d6b9e47aa375d6a932ebb47f4ab6f71e66b1` 已无法从上游获取，因此缺少 `ish/ish.h`、`alpine-rootfs.zip` 和 `RootfsPatch.bundle`。
- 所有临时构建图改动已经原样恢复，没有进入工作区差异。
- iPhone/iPad 完整 App 启动、收藏页多选到真实聊天、真机、签名与 Archive 尚未验证，必须在拥有完整 iSH 依赖、watchOS 平台和签名的发版环境完成。

## Phase 1 边界

本阶段没有迁移 `items.json`、没有引入新数据库或后台队列。SQLite 领域模型、迁移备份/恢复、TreasureJob、去重、tombstone 与 change log 留在 Phase 1 实施。
