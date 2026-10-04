# 隔离真实 HTTP 验证

此检查使用固定 Paperclip 上游源码和标准 CI 的一次性 PostgreSQL 18 服务。会实际启动 HTTP 服务并通过真实 Better Auth 注册/登录 Cookie，创建公司、任务、评论、文档和审批，验证创建/回复服务端去重，使用上游 `process` 适配器执行确定性的 Node 输出命令并等待真实运行终态和日志。

所有账号、口令、数据库和公司都是一次性 fixture；不连接生产数据库、不使用模型供应商密钥、不调用真实模型额度。脚本只接受回环测试 URL/数据库，临时配置目录和服务进程在退出时清理。真实 API 路由没有 mock。测试不覆盖 Codex/Claude 等付费模型，也不证明远程 Mac worker 或生产部署完成。

固定上游没有关闭 runner 模块加载的官方总开关。官方源码开发入口会导入 runner TypeScript；`process` 适配器是上游真实支持的非 native 执行路径，创建时明确不触发原生 provider 检查，所以此 job 不伪造 runner binary，也不把缺少 Rust 编译掩盖为 native 执行通过。Node 4GB约定来自固定上游 Dockerfile，仅用于标准 CI。完整发布镜像仍须按上游构建 Rust runner。

```sh
# 仅用于一次性本机/CI数据库，不能指向生产库
DATABASE_URL=postgresql://paperclip:paperclip-ci-only@127.0.0.1:5432/paperclip \
  bash scripts/paperclip-runtime/run.sh /path/to/pinned-paperclip
```

前置：Node 24.14、固定上游 `pnpm install --frozen-lockfile` 和 `pnpm --filter @paperclipai/plugin-sdk build`。原生登录窗口/中文页面的像素验收仍由各端 UI job 单独负责。工作目录中的 `summary.json` 明确注明真 HTTP / 确定性执行器与未覆盖项；运行失败保持非零退出码。
