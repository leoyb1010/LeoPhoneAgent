# 任务运行动态文案中文化

- 新增 153 个精确结构补丁，159 处命中，覆盖 54 个文件
- 从 HEAD 英文基线依次应用当前所有结构补丁后验证匹配，再执行合并词库转换；所有目标 TypeScript/JSX 可解析，无词库冲突
- 包含受控任务聊天、任务侧栏、文件/文档/产物、搜索筛选、决策提示、密钥绑定、初始化 UI、Dashboard/Inbox/Search/StatusCards/UserProfile/审计的模板
- 所有标识符、插值变量、运行命令、路径、用户提供名称、请求参数与已有条件分支保留；仅修改呈现文案，展示复数分支可用空串
- DecisionCard局部pluralize与humanStatus仅用于呈现；AttentionQueueRow行为颜色判定decisionVerbVariant继续读取原协议文案，不改其规则
- OnboardingWizard的6条CLI探测命令及Respond with hello探测输入保持原样；TweakPanel的CSS毫秒解析值保持原样
- 未运行完整类型检查/浏览器验证；此报告仅记录上下文命中与解析结果

## 仍保留的动态片段

- ui/src/components/AdapterLoginChrome.tsx:462 `提供你的 ${providerName} API 密钥以连接`
- ui/src/components/AdapterLoginChrome.tsx:484 `在运行 Paperclip 的计算机上为此连接登录 ${provider}，现有终端登录状态将保持独立。`
- ui/src/components/AdapterLoginChrome.tsx:484 `连接功能使用运行 Paperclip 的计算机上的本地 ${provider} 账号。`
- ui/src/components/FileViewerSheet.tsx:425 `${resource.title} 渲染后的 Markdown`
- ui/src/components/OnboardingWizard.tsx:1811 `无法保存 API 密钥：${err.message}`
- ui/src/components/OnboardingWizard.tsx:2068 `配置的 OpenCode 模型不可用：${selectedModelId}`
- ui/src/components/OnboardingWizard.tsx:2773 `提供你的 ${
                          CONNECT_SOURCE_NAMES[adapterType] ?? adapterType
                        } API 密钥以连接`
- ui/src/components/OnboardingWizard.tsx:2977 `${effectiveAdapterCommand} -p --mode ask --output-format json \"Respond with hello.\"`
- ui/src/components/OnboardingWizard.tsx:2979 `${effectiveAdapterCommand} exec --json -`
- ui/src/components/OnboardingWizard.tsx:2981 `${effectiveAdapterCommand} --output-format json "Respond with hello."`
- ui/src/components/OnboardingWizard.tsx:2983 `${effectiveAdapterCommand} -p "Respond with hello." --output-format stream-json`
- ui/src/components/OnboardingWizard.tsx:2985 `${effectiveAdapterCommand} run --format json "Respond with hello."`
- ui/src/components/OnboardingWizard.tsx:2986 `${effectiveAdapterCommand} --print - --output-format stream-json --verbose`
- ui/src/components/RunnerInspector.tsx:330 `${range} · ${groupEvents.length} 个 PRP 事件${groupEvents.length === 1 ? "" : ""}`
- ui/src/components/RunnerInspector.tsx:349 `PRP ${eventSourceId(event) || `事件 ${event.seq}`} · 无原始关联`
