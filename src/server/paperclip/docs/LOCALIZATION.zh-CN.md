# 中文化实现与维护契约

## 输入与输出

输入固定为 `upstream.lock.json` 的 Git commit。所有自动转换都从 `git show HEAD:<path>` 的固定源文件读取，不把已汉化源码当成下一次转换输入。输出写入独立上游工作目录，不把完整 Paperclip 复制进 LeoPhoneAgent 仓库。

顺序：
1. 校验 Git SHA 与全部 1121 个扫描源文件的 SHA-256（清单缺项或新增项也失败）
2. 按 `catalogs/order.json` 的显式顺序应用 `catalogs/*.structural.json`：每项包含完整原始上下文、替换文本、预期出现次数；不匹配立即失败。目录中未登记、清单中缺失/重复或违反 `after` 依赖的顺序都会失败，文件名前缀不再决定顺序
3. TypeScript AST 提取静态显示节点，对照扁平英文→中文词库
4. 使用 `contexts.json` 按文件、必要时按 `行号:源文本` 消除相同英文的歧义
5. 应用默认语言、日期、状态显示及中文错误组件的源码补丁
6. 重新解析所有修改的 TS/TSX，预检全部文件后才写入；无关本地修改一律拒绝覆盖
7. 输出 `reports/coverage.json`、`reports/extracted.json`。跟踪的根目录 `source-contract.json` 是唯一指纹基线（脚本读取它）；仅当升级时删除该基线后，才在 `reports/` 输出候选清单供审阅后复制回根目录

## 允许与禁止

可自动处理 JSX 静态正文、明确显示属性（label/title/placeholder/aria-label 等）、显示标签映射，以及经过限定的提示/错误设置调用。API 的 `body` 不属于显示文案；仅 `pushToast` 的 body 属于提示正文。复杂模板只通过已审阅、精确匹配的结构补丁处理。

不得改变用户数据、路由、请求字段、状态比较、缓存键、权限语义、标识/命令/路径、金额或币种。类型解析测试会覆盖这些反例。显示状态映射只在渲染时调用，未知枚举回退原值。原始 Error 对象、message、body 保留，既不打断上游依赖英文 message 的判断，也可在 UI 展开查看诊断。

JSX 中文文本编码为字面量表达式，译文中的括号、引号或 HTML 字样不会被解释为程序。没有运行时 DOM 遍历、正则替换用户内容、自动翻译请求或外部翻译服务。

## 词库协作

- `*.zh-CN.json`：英文源文本经过空白折叠、trim 后作 key，值为简体中文
- 相同 key 的多份全局词库必须同译，冲突会导致构建失败
- 不同语境必须放到 `contexts.json`，不能随意覆盖全局含义
- 复数尾缀 `s` 只能在核验的显示节点上下文中删除；不能全局替换所有 `s`
- 技术品牌/命令、代码示例等可保留英文，但应在覆盖报告中如实保留或列为已审阅例外
- 上游完整 i18next 体系尚未覆盖大多数界面，本层保留其验证机制并将默认语言设为 zh-CN；以后可把稳定词条迁回语义化 i18next key，不能直接批量破坏其他语言词库的 key 一致性

## 验证

```sh
node scripts/localize.mjs extract /path/to/paperclip
node scripts/localize.mjs apply /path/to/paperclip
node scripts/localize.mjs verify /path/to/paperclip
node scripts/apply-test-storage.mjs verify /path/to/paperclip
node scripts/apply-native-cli-auth.mjs verify /path/to/paperclip
node scripts/coverage-contract.mjs reports/coverage.json
node scripts/check-protocol-invariants.mjs /path/to/paperclip
# 完整回归：两个环境变量都要设置（默认 npm test 会跳过多数用例并打印跳过数）
PAPERCLIP_SOURCE=/path/to/paperclip PAPERCLIP_CANDIDATE=/path/to/paperclip npm test
npm run test:full   # 同上，默认指向 .upstream
python3 tests/native-launcher.test.py
./scripts/check-upstream.sh /path/to/paperclip   # 先装上游依赖，再跑回归、类型检查、UI 构建与冒烟
```

`PAPERCLIP_SOURCE` 是固定提交的上游 Git 工作区：测试只读取 `git show HEAD:<文件>` 原文并在内存中重放补丁；`PAPERCLIP_CANDIDATE` 是已生成的候选树，用于核对实际写出的文件。只设置前者时，候选产物比对仍会跳过。依赖上游 `ui/node_modules` 的回归需要先在上游树执行 `npx -y pnpm@9.15.4 install --frozen-lockfile`。

可用性修复（1.1.8）同样只走这两条通道：UI 逻辑放在 `catalogs/ui-usability.structural.json`（order.json 末位，依赖 round2 会话补丁的 main.tsx 上下文），后端放在 `native/ui-usability.patch.json` 与 `native/server/services/{issue-terminal-cleanup,company-deletion-sweep}.ts`，回归在 `tests/ui-usability.test.mjs`。

上游自身的 UI 测试仍断言英文文案的，按 `native/ui-test-assertions.patch.json` 以精确上下文改为当前中文或新契约（每条带 `category`/`reason`，只允许改 `ui/src` 下的 `*.test.ts(x)`），由 `apply-native-cli-auth.mjs` 应用和核对；不得删除断言或放宽为任意值。

工具层测试不能替代实际上游编译或浏览器验收。浏览器冒烟使用隔离的本地静态服务器和模拟 API，不访问真实账号，不发送真实认证/密钥，不执行智能体。生产验证须另外覆盖真实登录 Cookie、首次管理员权限、实际任务执行、审批与预算限制、数据库备份/恢复。

## 升级

新建上游工作目录并更新锁定 SHA；先运行提取，不允许把补丁失败改为静默跳过。逐一审核结构上下文和剩余文案；新增结构补丁 catalog 必须登记到 `catalogs/order.json`，跨 catalog 依赖写成 `after` 规则并注明原因；再更新指纹/覆盖基线，运行协议保留测试、UI 构建和冒烟。升级记录必须区分“已翻译静态候选”“已渲染验证”“未覆盖内容”，不得只依据词条数量宣称全量中文或生产可用。

## 全站剩余门禁与第三方 UI

`coverage-contract.json` 要求静态未审阅项为 0。`dynamic-preserve.json` 对仍含拉丁字母的动态模板逐文件、完整源码、分类和原因进行精确登记；新项与失效旧项都使 CI 失败，不以数量上限放行。`source-contract.json` 是完整扫描清单，不允许只核验已有 key。

Markdown 编辑器使用 MDXEditor 的官方 `translation` 回调，93 个键和插值契约在 `editor-contract.json`，保留 MIT 归属。翻译回调不接收也不改写用户 Markdown。第三方插件自己的界面不在宿主静态词库内。

日期转换只作用于经过审阅的显示文件。`cron-fires.ts` 中用于机器解析的 en-US formatToParts 保留。调度控件的内部 rawLabel 和 weekday value 保留，显示层再本地化；便携测试必须在 CI 设置 PAPERCLIP_SOURCE，避免跳过上游回归。
