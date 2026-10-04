# 连接与工具中文化第二轮

## 交付与验证

- 1505条中文词库；435条精确结构补丁，共439处替换
- 范围内111个TS/TSX文件从git show HEAD读取英文基线；包含报告未列出的纯展示/验证helper
- 合并全部当前结构补丁逐条验证命中数，再AST转换；111文件TypeScript/JSX解析全部通过
- 所有词库精确同译，无冲突（本次检查时）；AST候选2002，中文替换1982，明确保留6，未分类技术/标点14
- 未运行完整构建、类型检查或浏览器；留给服务集成任务验证

## 已核验边界

- Connections稳定AppStatus.label及connectionTypeLabel的英文判别值/union保留，渲染处中文映射
- ProfileDetail.sourceLabel的英文added by rule前缀保留，startsWith继续按原文判断，渲染处中文映射
- TEMPLATES的默认标题/说明元数据保留，在ProfileWizard/ProfilesIndex按key渲染中文；不改变默认名称或持久化内容
- 组织连接名称后缀、defaultAiConnectionName、API默认名、模型prompt、命令、路径、协议枚举、用户内容、API返回错误/提供方标签均保留
- 普通.ts只对已核验的纯展示函数、验证提示、导航及状态展示映射做精确补丁，不普遍翻译metadata label
- only file.read/parse evidence is claimed; no endpoint calls or external writes

## 后续验证事项

- 运行集成类型检查/完整构建，核验英文typed标签没有混入中文数据值
- 检查关键页面截图：授权与撤销确认、外部消息投递未知/重试、环境变量敏感值警告、邀请登录及访问配置
- 服务商返回标签/错误原文、默认生成账号名、原始协议值不是遗漏，应按产品边界保留
- shared库中的mcpRemoteHeaderRejectionMessage返回文本不属于本次UI源码所有权，需集成方决定是否增加纯展示翻译

## 技术保留（非真实未译文案）

- ui/src/components/environment-variables-editor/CreateSecretPopover.tsx:92 "secret_name"
- ui/src/components/environment-variables-editor/Row.tsx:217 "KEY"
- ui/src/components/environment-variables-editor/Row.tsx:414 "v"
- ui/src/components/environment-variables-editor/SecretPicker.tsx:327 "&ldquo;"
- ui/src/pages/InviteLanding.tsx:196 "POST"
- ui/src/pages/apps/app-detail/RailwayAccessPanel.tsx:57 "ssh.railway.com ssh-ed25519 …"
- ui/src/pages/apps/app-detail/SetupPanel.tsx:218 "https://docs.google.com/spreadsheets/d/..."
- ui/src/pages/secrets/UserSecretDefinitionsTab.tsx:270 "PERSONAL_GH_TOKEN"
- ui/src/pages/secrets/proposal-review.tsx:427 "dev/github"
- ui/src/pages/secrets/proposal-review.tsx:437 "client-secret"
- ui/src/pages/tools/ProfilesTab.tsx:1308 "p"
- ui/src/pages/tools/SmokeLabTab.tsx:480 "ms"
- ui/src/pages/tools/connection-dialogs.tsx:388 "https://mcp.example.com"
- ui/src/pages/tools/connection-dialogs.tsx:478 "vault://"

## 纯函数回归验证

已在内存编译英文与中文模块，比较44组真实函数输出：defaultAiConnectionName所有4服务商×2登录方式×4所有者输入、connectionTypeLabel及组织连接持久化后缀均保持不变。未替代完整类型检查或浏览器测试。

最后的展示专用owner possessive采用“姓名的”，保留自定义名称、邮箱、域名与持久化字段；全范围未发现新增label-derived DOM ID依赖。
