# LeoPhoneAgent 1.1.0 开发检查点

正式版本：`1.1.0`  
稳定基线：`leophoneagent-1.0.12` / `eeb3ea1`  
开发策略：中间只递增 Build，不覆盖安装正式版；每个高风险层独立提交，可定位、可测试、可回滚。

## 检查点规划

| Build | 范围 | 状态 | 回滚边界 |
|---|---|---|---|
| 14 | ChatStore Schema Contract、迁移与恢复测试门禁 | 已完成 | 不新增用户数据类型，可直接回到 1.0.12 |
| 15 | Artifact 本地模型与文件生命周期 | 已完成 | 尚未接入 UI/CloudKit，独立提交可整体回滚 |
| 16 | Artifact Tray、Quick Look、分享 | 待开始 | UI 与数据模型分离 |
| 17 | Artifact 版本与聊天/任务/Files 统一引用 | 待开始 | 保留原始文件引用 |
| 18 | CloudKit V2 / CKAsset | 待开始 | 默认关闭同步，先完成双读与回滚演练 |
| 19 | 个人任务模板与结构化输出 | 待开始 | 独立数据类型 |
| 20 | Composer、首页与运行策略定制 | 待开始 | Feature Flag |
| 21 | 动效、触感、Reduce Motion、无障碍 | 待开始 | 纯表现层 |
| 22–23 | 全流程回归、迁移演练、真机审计、1.1.0 发布 | 待开始 | 发布候选标签 |

## Build 14 证据

- `ChatStoreSchemaContract` 由生产 `ChatStore.createTables()` 调用，不是测试专用副本。
- Schema 变更使用 `BEGIN IMMEDIATE` / `COMMIT`，失败执行 `ROLLBACK`。
- 覆盖新库、旧库升级、数据与派生字段保留、幂等重跑、缺表缺列检测。
- macOS SQLite runner：`ChatStoreSchemaSmoke: 4/4 passed`。
- `MinisTests.xctest`：编译及链接成功。
- 通用 iOS arm64 主 App：`BUILD SUCCEEDED`。
- Xcode iOS Simulator runner：启动 worker 阶段停滞并人工中断，不计为测试执行通过。

复现 smoke runner：

```sh
xcrun swiftc \
  src/ios/Agent/Chat/ChatStoreSchemaContract.swift \
  scripts/ChatStoreSchemaSmoke.swift \
  -o /tmp/LeoPhoneAgentChatStoreSchemaSmoke \
  -lsqlite3
/tmp/LeoPhoneAgentChatStoreSchemaSmoke
```

## Build 15 证据

- Schema Contract 升级到 v2，事务式、幂等创建 `artifacts` 与 `artifact_versions`。
- Artifact 文件使用受控根目录、安全文件名与标准化路径校验，避免目录穿越。
- 新建和追加版本先进入 staging；数据库事务失败时回滚并清理未提交文件。
- 覆盖新建、追加版本、版本顺序、SHA-256、软删除、恢复、永久清理与危险文件名。
- `ArtifactRepositorySmoke: lifecycle passed`。
- `ChatStoreSchemaSmoke: 4/4 passed`。
- Swift 6 `MinisTests.xctest` 编译及链接成功；通用 iOS arm64 主 App `BUILD SUCCEEDED`。
- 本检查点只建立本地能力，不接入 Artifact Tray，不向 CloudKit 写入，也不安装到真机。

复现 Artifact runner：

```sh
xcrun swiftc -parse-as-library \
  scripts/ArtifactRepositorySmoke.swift \
  src/ios/Agent/Artifacts/ArtifactModels.swift \
  src/ios/Agent/Artifacts/ArtifactRepository.swift \
  src/ios/Agent/Chat/ChatStoreSchemaContract.swift \
  -o /tmp/LeoPhoneAgentArtifactRepositorySmoke
/tmp/LeoPhoneAgentArtifactRepositorySmoke
```

## 回滚规则

1. 1.0.12 稳定基线不得改写或移动标签。
2. Artifact 与 CloudKit 分属不同检查点，禁止合并成不可拆分提交。
3. 新数据能力先关闭写入与同步，再完成旧库 fixture、幂等迁移和降级读取验证。
4. 只有 Build 22–23 完成真机迁移演练后才将正式版本号改为 1.1.0。
