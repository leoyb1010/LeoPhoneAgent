# 藏宝阁 Phase 1 交付证据

日期：2026-08-30
基线：`main` / `4198e397fdeec7c715cd8941f31d9f86d48adafa`

## 完成范围

- iOS 主存储从 `items.json` 切换为 SQLite WAL 和短事务；旧 JSON 仅作一次性迁移源与 SQLite 打开失败时的不丢数恢复路径。
- iOS 迁移包含原文件备份、坏条目隔离、重复 ID 隔离、事务回滚、失败重试和并发首次打开单次迁移。
- iOS 数据层新增 item / collection / chunk / job / change / FTS 表，支持有界分页、索引重建、tombstone、URL 规范化去重、文件流式 SHA-256 去重和持久任务退避。
- Android `AppDatabase` 10 → 11，新增 Room 实体、DAO、Repository 和 Migration；Standard 公共数据层不依赖 Accessibility、Shizuku、悬浮窗或 Power 权限。
- Android 去重检查已放入 Room 事务，支持并发捕获、批量 JSON 导入、坏条目隔离、持久 job/change/tombstone、FTS4 索引辅助表与触发器。
- Mac 复用 leocodebox `better-sqlite3` 连接、schema 和用户体系，新增 Treasury repository/service，支持用户隔离、FTS5、search/get/save/update、job/change/tombstone 与导入导出。
- Mac JSON/Markdown 导出改为分页读取全部活跃条目，不再静默截断在 500 条；`update` 不能通过 `deleted_at` 绕过独立 tombstone 接口。
- 三端共享 `treasure_item_v1.fixture.json` snake_case 契约样本，iOS 导入导出保留 byte count、digest、MIME、合集、阅读/处理/同步状态和设备 ID。
- JSON、Markdown 和浏览器 HTML 导入导出已在三端建立；URL 去除 tracking 参数后不保留空 `?`，导入返回实际新增数量。
- 本地引用拒绝目录穿越、绝对路径、Windows 盘符和 NUL；digest、时间戳、枚举状态和 HTTP(S) 来源在入库前校验。

## 三轮审计与修复

1. 数据完整性审计：修复 iOS 自定义存储目录附件字节数错误、契约导出丢 `byte_count/content_digest`、首次迁移竞态和 Mac 500 条导出截断。
2. 安全与契约审计：修复 Windows 盘符/NUL 路径边界、Android `update` 校验绕过、Mac `deleted_at` 更新绕过，并统一 source、digest、MIME、时间戳和状态字段。
3. 并发、去重与恢复审计：将 Android ID/URL/digest 检查移入 Room 事务；补齐 iOS 并发首次迁移、1,000 条分页、导入精确计数和 tracking-only URL 去重回归。

## 自动化验证

### iOS / iPadOS 逻辑与 Share Extension

```bash
xcodebuild -project src/ios/LeoPhoneAgent.xcodeproj \
  -scheme MinisLogicTests -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -packageAuthorizationProvider netrc CODE_SIGNING_ALLOWED=NO \
  -parallel-testing-enabled NO test
```

结果：298/298 全量逻辑测试通过，0 failed，0 skipped。

Treasury 定向 27/27 测试通过，包含迁移备份/坏条目/失败重试/并发首次打开、App/Share 并发写、URL 与 digest 去重、job 退避、tombstone、索引重建、导入导出、契约往返和 1,000 条分页。

```bash
xcodebuild -quiet -project src/ios/LeoPhoneAgent.xcodeproj \
  -target MinisShare -configuration Debug -sdk iphonesimulator -arch arm64 \
  -packageAuthorizationProvider netrc CODE_SIGNING_ALLOWED=NO build
```

结果：MinisShare Simulator 目标编译成功。

### Android Standard / Power

```bash
./gradlew \
  :app:compileStandardDebugKotlin :app:testStandardDebugUnitTest \
  :app:lintStandardDebug :app:compileStandardDebugAndroidTestKotlin \
  :app:compilePowerDebugKotlin :app:testPowerDebugUnitTest \
  :app:lintPowerDebug :app:compilePowerDebugAndroidTestKotlin
```

结果：Standard 与 Power 编译、JVM 单测、lint 和 androidTest 源集编译全部成功；Android lint 为 0 errors，仓库既有 529 warnings / 37 hints。

已编写但本机无设备/AVD 而未执行的 instrumentation 测试：10→11 migration 建表/FTS 触发器、JSON 导入坏条目隔离、Room 事务并发去重。

### Mac leocodebox

```bash
npm run typecheck
npm run test:server
npm run build
```

结果：typecheck 通过；server 376/376 测试通过；Vite client 与 TypeScript server production build 成功。

Treasury repository/service 定向 integration 7/7 测试通过，额外验证持久化、用户隔离、去重、FTS5、job/change/tombstone、JSON/Markdown/HTML、501 条完整导出、非法路径/来源/digest 和 1,000 条分页/搜索性能门禁。

## 当前环境门禁

- Android `adb devices` 无设备，`emulator -list-avds` 为空；API 26、Fold8 封面/展开屏、200% 字体、进程死亡和真机 migration 未执行。
- iOS 主 App 仍受缺失的固定 iSH 子模块资源和 watchOS 26.5 平台阻塞；本机完成逻辑测试与 Share Extension 编译，没有虚报主 App 真实启动、真机、签名或 Archive。
- Mac 本机完成 typecheck/test/build；本阶段没有实施 Phase 4 工作台 UI，也没有宣称签名、公证或热更新已完成。
- 10,000 条、电量、长时后台和真实跨端同步性能属后续阶段/设备环境门禁，本阶段不虚报。

## Phase 2 边界

本阶段建立数据层和持久任务队列，未越级实施 Android 完整页面、ShareReceiver “收进藏宝阁”、WorkManager OCR/解析、Fold8 UI、Mac 主动工作台或游标增量同步。这些继续按施工规范进入 Phase 2。
