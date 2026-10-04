# LeoPhoneAgent · Paperclip 中文服务器发行层

这里交付的是**可审查、固定源码版本、构建前完成的简体中文发行层**。Web 管理后台由 Paperclip 服务器提供，Mac 客户端连接这个服务；智能体 CLI 在服务器或管理员配置的运行环境执行，不会因此获得用户 Mac 的终端能力。

- 上游：`paperclipai/paperclip`
- 固定提交：`994d6edcdd4e15d5f9cc5cf8c135ac599104b86a`
- 授权：MIT，完整保留于 `LICENSE.paperclip`
- 未在本次工作中部署服务器、建立真实账号、配置真实密钥、连接模型服务或运行收费智能体

## 使用

```sh
cd src/server/paperclip
npm ci --ignore-scripts
npm test
./scripts/prepare.sh /你的独立工作目录/paperclip-zh
./scripts/check-upstream.sh /你的独立工作目录/paperclip-zh
./scripts/build-image.sh /你的独立工作目录/paperclip-zh
```

`prepare.sh` 只准备源码，不启动服务。已有目标目录必须处于锁定提交；工具拒绝覆盖无关本地改动，不执行 `git reset`。中文补丁可以重复应用，也可以离线对已经检出的上游运行：

```sh
node scripts/localize.mjs extract /path/to/paperclip
node scripts/localize.mjs apply /path/to/paperclip
node scripts/localize.mjs verify /path/to/paperclip
```

详细部署、登录、备份和回滚步骤见 [中文部署手册](docs/DEPLOYMENT.zh-CN.md)。维护方法和验证范围见 [中文化维护说明](docs/LOCALIZATION.zh-CN.md)、[覆盖矩阵](docs/COVERAGE.zh-CN.md)。

## 实现边界

这不是浏览器自动翻译，也不是 DOM 文本替换。TypeScript AST 只识别显示文案位置，使用可审阅词库在构建前改写源码；复杂模板和帮助函数使用固定上下文补丁。生产版及普通版页面均纳入处理。

用户填写的任务标题/正文、评论、智能体输出、文件内容、公司名称不会被自动翻译；API 字段、路由、缓存键、协议枚举、权限判断、金额数值及币种也不会改变。CLI 输出、原始诊断、品牌、模型名、命令和路径保留原文。默认界面语言为 `zh-CN`，金额仍为美元，并不执行汇率换算。

代码里存在的候选文案数量不等于实际翻译数量，也不能证明所有运行态页面都已验收。`reports/coverage.json` 提供逐文件的实译/剩余清单，覆盖矩阵会明确未覆盖的功能与未完成的验证。
