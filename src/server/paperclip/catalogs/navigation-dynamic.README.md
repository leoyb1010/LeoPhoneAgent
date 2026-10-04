# 导航、动态文案与显示 helper 中文化（第三轮）

## 范围与结果

- 上游输入固定为 `994d6edcdd4e15d5f9cc5cf8c135ac599104b86a` 的 `git show HEAD:<file>`；不从已经应用中文覆盖层的工作树提取英文
- 新增 `navigation-dynamic.structural.json`，共 **489 条精确补丁、524 个匹配位置、73 个源文件**；本轮检查范围为 86 个文件
- 先合并现有结构补丁排重，再生成精确上下文补丁；前两轮 `tasks-agents` 和 `workflows-skills` 词库未改动
- 重点覆盖导航与侧边栏的屏幕阅读器说明、动态操作/确认/提示、活跃运行与活动图表、任务与成员选择器、恢复与重试说明、技能操作、任务详情、实时通知，以及适配器界面的路径提示与权限说明
- `dynamicRemaining` 在本轮范围内剩余 **7 处**：5 处已是中文且保留 Paperclip、GitHub 或 Mermaid 名称；另 2 处为重新创建任务时写入 API 的默认标题，刻意保留
- 本轮范围的当前静态 AST 报告：1,655 个候选、1,611 个词库替换、44 个技术/品牌保留、0 个未处理候选。它只代表提取器可识别位置，不代表所有英文、外部数据或应用界面已经完整覆盖

## 行为与数据边界

- API 请求、持久化业务默认值、字段名、类型字面量、路由、命令、事件 schema、请求/选项 ID、权限配置值与用户内容保持原样
- 保留 `Re-issue (isolated): …`、重新创建任务的审计说明、`Approved plan`/`Requested changes` 评论默认数据、侧边栏暂停/重启审计原因等
- `IssueDetail` 的 `Assignee`/`Originating` 类型值、`IssuesList` 的 `Paused` 内部标记，以及 `runRetryState` 的 `Manual intervention required` 检测串保持原样，只修改最终显示
- `IssueProperties` 对原始 `formatMonitorEta` 的 `due now`/`overdue by ` 判断保持原样；时间显示 helper 由服务集成层提供；本轮仅在 IssueMonitorBanner、IssueScheduledRetryCard、IssueBlockedNotice、IssueProperties 的最终显示位置调用 displayMonitorEta，不对控制字符串做机械替换
- `CompanyAccess` 通过本地角色与成员状态字典显示中文。共享角色常量不变，原生 option 的提交 value 不变，未知值原样返回
- 适配器权限说明和选项名在 `CodexLocalConfigFields` 渲染处通过本地字典翻译。共享 `PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES` 的值、默认模式、配置 key 和权限校验完全不改，未知标签保留原值
- `paperclip-runner/index.ts` 只修改 UI 内存转录模型中由客户端生成的系统说明、显示标题与缺省问题/回答/选项标签。服务商返回的内容、用户输入、toolName、字段 name、schema、requestId、optionId、响应对象与原始 payload 不变
- 复数词尾仅在明确的完整展示模板中处理，不提供 `s` 到空串的通用规则。变量和条件保留；少数模板按中文语序重排插值位置

## 验证

1. 全部结构补丁按生产加载顺序重放到锁定的原始源码，逐条校验 `expected`；所有生成 TypeScript/TSX 可解析，词库转换与全站 `extract` 通过；指定上游路径的 `npm test` 最终为 19/19 通过
2. 独立只读审查另验证了 runner parser 的 8 组样本：request/turn/question/option/field 标识、选择键、状态与服务商内容不变；发现并修正了 root-denied 的中文解释，它表示默认拒绝根文件系统访问，并非禁用超级用户权限
3. 本轮前后 AST 合同比较通过：**1,995 个比较表达式、936 个类型字面量、44 个 API 写入调用、73 个原生表单 value 属性**未改变。比较表达式按多重集合比较，允许纯展示模板采用中文语序
4. `tests/workflows-schedule.test.mjs` 为可移植的原始英文/中文对照测试，使用服务自身的 TypeScript 依赖，并从锁定上游 HEAD 在内存重建所有结构词库涉及的文件，不依赖临时目录，也不写上游
5. 调度回归覆盖 **374,976 组** cron 组合，每组两轮字段修改和重新读取。另验证所有小时/分钟的午夜与中午显示、AM/PM 原始标签、原生 select 选项值和真实 onChange 结果、星期英文存储值、IANA 时区、默认 draft 与自定义 cron 不变

运行完整测试：

```sh
PAPERCLIP_SOURCE=/absolute/path/to/pinned/paperclip npm test --prefix src/server/paperclip
```

未设置 `PAPERCLIP_SOURCE` 时，上游调度回归明确显示 skip，独立词库测试仍执行。CI 应指定正确上游路径；一旦指定，路径错误、HEAD 不匹配、补丁匹配失败或 AST 错误都会直接失败，不会静默跳过。

## 未包含的验收

本轮没有单独发布、推送上游、修改共享协议或运行设备验收。完整应用构建、浏览器交互和 Mac/iOS 验收由集成负责人继续执行。未知扩展标签、用户或服务商内容、原始诊断及明确保留的技术标识不在本轮机械翻译范围。
