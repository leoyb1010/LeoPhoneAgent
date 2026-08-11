# leocodebox 1.54.0 — Leoapi 网关(beta · 融合第一步)

融合 opencodex「本地协议代理」思路的第一步:给 Leoapi 加了一个 **opt-in、默认关** 的本机计量网关。开启后,当前 Leoapi 节点的 Claude 流量经本机 127.0.0.1 网关**忠实转发**(逐字节透传,不改写不重组),并第一次做到**请求级(wire 级)token 计量**。全程本地、loopback-only、一键可关。

## 多了什么
- **Leoapi 网关(驾驶舱右栏新卡,beta)**:一个开关 + 实时计量。开启后把 active Leoapi 节点的 `ANTHROPIC_BASE_URL` 指向本机网关,并用一枚 `lgw:<节点>` 令牌替换 CLI env 里的真实 key(**真 key 从此不进 CLI 环境**),网关按令牌转发到该节点真实上游。
- **请求级计量**:每个经网关的请求当场记账(模型/输入·输出·缓存读 token/成本),卡上显示今日请求数/tokens/成本 + 最近几条。与既有 usage_daily 事后聚合**互不干扰、零双计**(网关计量独立内存态,不写 usage_daily)。
- **化繁为简**:注入机制、节点管理、健康监控全部复用,网关只是把「会话级 env」升级成「请求级转发」的落点;是后续「请求级路由 / mid-session 故障转移 / 账号池」的地基。

## 安全与边界(重要)
- **默认关**。不开启则行为与 1.53 完全一致(spawn 期 env 接管,机器原配置在无 active 时权威)。
- **忠实透传**:响应字节原样 pipe 回 CLI,计量只读一份 tee 副本——计量出错也**绝不影响**转发流。
- **loopback-only**:网关自校验 remoteAddress,只接受 127.0.0.1;经 `lgw:` 令牌鉴权(不占用 app 本地 token)。
- **fail closed**:上游失败返回真实错误,绝不静默回退到别的路由。
- **beta**:首次开启建议先用一个节点实测再依赖;一键即可关回。

## 验证
- 门禁全绿:typecheck 0、ESLint 0(含 design-system 规则)、client 71/71、server **304/304**(新增 5 条网关计量/透传单测)、生产构建通过。
- 单测覆盖:Anthropic SSE 与非流式两种响应的 usage 解析、坏数据零计不抛、上游 header 剥离/注入、计量聚合。
- 原生模块 ABI 复核:Electron 运行时正常。

## 后续(融合路线)
- 下一步:请求级槽位路由 + mid-session 故障转移;再接 pi 自有内核(第 6 家 provider);另有 compaction 降本、shadow-call 拦截、sidecars 能力回填等已排期。

## 下载校验
- DMG SHA-256:`4e2c14a46cf4fc7efa949552d0140361d8ec58d25b68dbf014ee1c17f1029e52`
- ZIP SHA-256:`9cf7c758cce75f4e2a3ada7ef1a3c2b1d6ccb037f29bca71676fff6f55d468a0`
- `latest-mac.yml` SHA-256:`685d4e9761285f38d9a0a48dbc7e5e13f0174f0ae930ba78bcc973aab9f7103f`

> 注:本版 DMG 未做窗口背景美化(本机 Finder 自动化权限被系统重置,-1743),纯功能包,不影响安装/签名/公证。
