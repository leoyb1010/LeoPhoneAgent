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

## 去重与退出边界证据

固定上游提交 `994d6edcdd4e15d5f9cc5cf8c135ac599104b86a`：

- `server/src/services/issues.ts` 的创建流程（9845–9900附近）对 `companyId + idempotencyKey` 使用事务级 advisory lock，并从 `issueCreateIdempotencyKeys` 查回原任务。237–239行规定幂等键保留7天，9864附近按此期限清理。客户端持久保存首次提交时间，保守地只允许6天内直接重试；旧草稿缺时间戳、设备时钟倒退、窗口过期均先停下让用户核对
- 同文件12245–12247附近按 `issueId + authorUserId + clientRequestId` 查回已有回复。未知回执不会自动生成新UUID或重发；草稿和请求编号按配置、公司、人类用户、任务隔离
- `PaperclipCookieVault` 为每个配置串行化 Cookie 写入和清除，清除首先撤销代际，再等待正在进行的写入完成，最后清空。旧回调即使晚到也不能回填；`clearLogin` 完成后还要通过配置与状态版本检查才能修改忙碌状态
- `PaperclipWebKitTests` 同时覆盖真实容器隔离和可控异步回归：写入中退出、旧代际迟到写入、切换配置后旧清除不能解除新配置忙碌状态
- 运行日志以64KB为一段，按服务端 `nextOffset` 继续读取；界面明确告知原始输出和手动刷新，不宣称实时全日志
