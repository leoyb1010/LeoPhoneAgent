# Leo Link：权限模式、改动面板与每轮检查点

手机（iOS 会话页）经 Leo Link 切权限模式、看会话工作区的改动、按轮回滚。实现：
`packages/desktop/src/host/leo/link/bridge.ts`（路由）、`session.ts`（模式事件、检查点时机）、`changes.ts`（git）。
字段蛇形命名，和其它 `/harness` 路由同风格、同鉴权（中继 / 直连已配对设备）。

## 规则

- 模式只有四种：`plan`（先计划）、`guarded`（自主）、`build`（逐项确认）、`yolo`（全自动）。切到 `yolo` 和
  `full_auto` 同级：认不出设备（中继 0.1）回 403 `device_not_recognized`。模式的唯一所有者是 CLI 任务
  （`taskService.setMode`）；`LinkSession.mode` 只是镜像，随 `mode_update` 更新。
- 模式变化（手机切的、Mac 桌面上切的）写进事件日志：`{"event":"mode","type":"mode","mode":…}`（带 seq，可续传）。
- 创建会话的 `mode` 优先于 `full_auto` 映射（开→`yolo`，关→`build`）；会话摘要、列表项、创建回执都带 `mode`。
- 改动以仓库根为准（会话工作区所在仓库，`git rev-parse --show-toplevel`），路径相对仓库根；非 git 目录 `is_repo:false`。
- 「现在的工作区」= 临时 index（复制真 index）`git add -A` + `write-tree`：含未跟踪、遵守 `.gitignore`，不碰用户 index。
- 检查点：每轮开始时拍一棵这样的树，包成无父提交挂到 `refs/leobot/checkpoints/<会话>/<轮次>`（防 gc，带时间与标题）。
  轮次接着该会话已有的 ref 往下编；同一会话的创建串行。非 git 目录不建。
- 回滚只动工作区：目标树里没有、现在有的文件删除（连带空目录），其余从目标树写回；不动 index、不动提交历史。
  任务在跑（running / waiting_for_approval）时 409；中继 0.2 下认不出身份的调用方 403。

## 检查点时机

```
手机 send（新一轮）──► user.message 落日志 ──► 拍检查点（await）──► sendPrompt ──► agent 开始改文件
手机 send（在跑：插话）────────────────────────────────────────► sendPrompt（不拍）
Mac 桌面发起 ──► task_run_started ──► run.started ──► 拍检查点（尽力而为，可能晚于 agent 的第一笔改动）
run.completed / failed / cancelled ──► 本轮标记复位
```

## 接口

- `POST /harness/sessions/:id/mode` `{"mode":"plan"}` → `200 {"mode":"plan"}`；非法 400，认不出设备开 yolo 403。
- `GET /harness/sessions/:id/changes` →
  `{"is_repo":true,"cwd":"/Users/me/app","branch":"main","files":[{"path":"a.txt","status":"M","additions":1,"deletions":0},{"path":"new.txt","status":"?","additions":1,"deletions":0},{"path":"b2.txt","status":"R","additions":0,"deletions":0,"old_path":"b.txt"}],"checkpoints":[{"id":"1","turn":1,"created_at":"2026-10-20T03:30:00Z","label":"改 a"}]}`
  （files 相对 HEAD；status：M 改 / A 新增已跟踪 / D 删 / R 改名 / ? 未跟踪）
- `GET /harness/sessions/:id/diff?path=a.txt[&checkpoint=1]` →
  `{"path":"a.txt","diff":"diff --git a/a.txt b/a.txt\n…","truncated":false,"binary":false}`；
  不带 checkpoint 相对 HEAD（含未跟踪），带则相对该检查点；diff ≤256KB（截在整行），超出 `truncated:true`。
  路径越界 / 绝对 / `.git` 内 400，检查点不存在 404，非 git 409。
- `POST /harness/sessions/:id/revert` `{"checkpoint":"1","paths":[]}` → `{"reverted":["a.txt","new.txt"],"checkpoint":"1"}`；
  只带 `paths` → 恢复到 HEAD → `{"reverted":["a.txt"]}`；两者都没有 400。
- 第二波（未做）：`GET /harness/external-sessions`、创建时 `resume_external`（接管终端里的 Claude 会话），分流点在 `create()`。

## 验收

- `node --import ./scripts/test-isolation/home.mjs --import tsx --test packages/desktop/src/host/leo/link/changes.test.ts`：
  临时仓库两轮检查点 → changes / diff（HEAD 与检查点）→ 回滚到检查点 / 单文件回 HEAD，index 与提交历史不变。
- `bridge.test.ts` 的 `mode / changes / diff / revert routes`：经桥接走完整条路由（含模式事件、插话不新建检查点、非 git 目录）。
