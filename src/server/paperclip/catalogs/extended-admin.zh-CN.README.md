# 扩展后台中文化审阅

仅审阅 7 个指定页面；未修改上游源码、接口响应、用户内容或协议值。

## 已交付

- `extended-admin.zh-CN.json`：733 个英文源文案→中文词条；与其他词库无冲突
- `extended-admin.structural.json`：185 个精确上下文补丁，186 次替换；须先结构补丁、再 AST 词库
- 七页结构补丁逐条命中数验证及转换后 TypeScript/JSX 解析全部通过；没有声称完整上游构建或运行时界面已验证
- 结构补丁含 96 个 helper/静态上下文、70 个动态模板、16 个展示复数尾缀行，以及 SecretStatus 纯展示映射、密钥名词和完成配置按钮

## 保留与边界

- 保留版本前缀 v、PID、SSH、npm 软件包名、路径示例、URL、环境变量键、AWS 协议/操作标识
- Secrets 小写 secret 的读屏文案已单独改为密钥；Vault 挂载路径占位符 secret 保留
- All secrets 的面包屑内部显示值比较与对应显示标签同步翻译；不涉及 API 或持久化值
- API 返回的错误、插件描述、用户命名/内容和 CompanyExport 生成的导出包 Markdown 文档未改写
- PluginSettings 的动态 plugin/health/worker/job 状态需主集成使用纯展示状态映射（不能更改 API 枚举）；仍需主集成端到端 UI 与构建验证
- 同页 helper 的返回文案不能依赖 AST 静态提取自动发现，必须加载结构补丁
- 唯一 expected=2 为 CompanyImport 两处相同的上传续传提示；其他补丁 expected=1

## 逐页结果

### ui/src/pages/AdapterManager.tsx

原始 AST 候选 73；结构补丁 6；结构之后候选 73，词库命中 70。未翻候选仅保留技术内容：

- L88："v"
- L463："/mnt/e/Projects/my-adapter or E:\\Projects\\my-adapter"
- L480："my-paperclip-adapter"

### ui/src/pages/CompanyEnvironments.tsx

原始 AST 候选 175；结构补丁 64；结构之后候选 174，词库命中 172。未翻候选仅保留技术内容：

- L2261："SSH"
- L2307："/Users/paperclip/workspace"

### ui/src/pages/CompanyExport.tsx

原始 AST 候选 51；结构补丁 6；结构之后候选 49，词库命中 49。未翻候选仅保留技术内容：


### ui/src/pages/CompanyImport.tsx

原始 AST 候选 107；结构补丁 27；结构之后候选 97，词库命中 94。未翻候选仅保留技术内容：

- L187："&rarr;"
- L246："&rarr;"
- L1927："https://github.com/owner/repo/tree/main/company"

### ui/src/pages/PluginManager.tsx

原始 AST 候选 65；结构补丁 2；结构之后候选 65，词库命中 63。未翻候选仅保留技术内容：

- L218："@paperclipai/plugin-example"
- L401："· v"

### ui/src/pages/PluginSettings.tsx

原始 AST 候选 81；结构补丁 21；结构之后候选 81，词库命中 77。未翻候选仅保留技术内容：

- L181："v"
- L318："PID"
- L550："v"
- L759："/absolute/path/to/folder"

### ui/src/pages/Secrets.tsx

原始 AST 候选 419；结构补丁 59；结构之后候选 414，词库命中 386。未翻候选仅保留技术内容：

- L2109："v"
- L2182："v"
- L2281："v"
- L2662："clientsecret"
- L2682："/dev/foo/bar"
- L2717："arn:aws:secretsmanager:..."
- L2774："PERSONAL_GH_TOKEN"
- L3790："us-east-1"
- L3791："production"
- L3792："paperclip"
- L3793："alias/paperclip-secrets"
- L3794："platform"
- L3795："prod"
- L3803："paperclip-prod"
- L3804："global"
- L3805："production"
- L3806："paperclip"
- L3813："https://vault.example.com"
- L3814："admin"
- L3815："secret"
- L3816："paperclip/prod"
- L3992："secret_provider_config.discovery.preview"
- L3996："aws_secrets_manager"
- L4000："draft_config"
- L4093："secret.create"
- L4597："MY_SECRET"
- L4660："v"
- L4735："v"

