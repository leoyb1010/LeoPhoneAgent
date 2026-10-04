# iOS Paperclip 原生验证

在 macOS 的 Xcode 26.6 / iOS 26.5 模拟器上运行：

```sh
brew install xcodegen
bash scripts/native-paperclip-audit/run.sh
```

此独立宿主直接编译 `src/ios/Agent/Paperclip` 与 `src/ios/Views/Paperclip` 中全部生产 Swift 文件，不加载 iSH、FFmpeg、Watch 或原 App。它运行：

- Foundation 契约、身份绑定、HTTPS 地址、状态中文、草稿恢复测试
- URLProtocol 生产客户端测试：人类会话、Cookie 范围、禁止 Bearer Key、超时不确定性、回执、跨公司数据拒绝
- 真实 WebKit 容器隔离与配置恢复测试
- 真实 SwiftUI 界面旅程：默认本机、切换服务器、中文空状态、HTTP 拒绝、取消与反复返回，并保存截图

`PaperclipContractTests`、`PaperclipClientTests` 也加入现有 `MinisLogicTests`。独立宿主另外编译全部新 UI，不能用逻辑测试通过代替 UI 编译。

输出为 `native-paperclip-audit-results/` 下的构建日志、测试摘要和带截图的 `.xcresult`。使用 `PAPERCLIP_TEST_DESTINATION` 可指定实际已安装的模拟器。Linux 上脚本退出 2，明确报告未执行原生验证。

这些是隔离契约和原生控件测试，不能证明真实部署的 Better Auth 登录、真实代理运行或真机后台行为。发布前还需用独立部署的中文 Paperclip 服务器完成：HTTPS 登录和退出、账号与公司切换、创建后断网及重试、回复断网及重试、状态与审批冲突、日志权限、重启草稿恢复、后台返回与动态字体检查。服务器任务不会因超时改用本机。

## 客户端边界回归

- 前台刷新必须重新读取已经加载的任务页，不能每 15 秒把列表截回第一页；公司切换后的旧响应不能发布到新公司。
- 登录浏览器只允许当前配置的 HTTPS origin 导航；994 的 `/auth` 表单登录可以使用，不开放任意 HTTPS 外跳或未经支持的外部 OAuth 流程。
- 994 的任务创建去重键只保留 7 天。首次提交前持久化时间与请求编号；7 天后、时间异常或旧草稿没有时间时保留内容并要求核对服务器，禁止再发送同一创建。期限内沿用原编号，不能宣称永久去重。
- 服务器明确拒绝的创建或回复保留正文并恢复编辑；只有未知提交结果锁定原内容等待核对。此工作台当前不提供运行取消、附件或产物下载。
