# LeoBot agent regression eval

A private regression set for the LeoBot agent. Run it from this Mac before shipping a prompt or model change.
It drives a **real** Mac LeoBot end to end through Leo Link, the same protocol the phone uses, routed via the relay
(`https://relay.leoyuan.top/relay/api/m/<Machine>`). Python stdlib only.

```
python3 scripts/eval/leo_eval.py --k 1                                   # full set once (~32 tasks, ~15–20 min)
python3 scripts/eval/leo_eval.py --k 3 --only qa_today,automation_create # pass^3 on chosen tasks
python3 scripts/eval/leo_eval.py --only category:safety,category:brain   # whole categories
python3 scripts/eval/leo_eval.py --k 3 --baseline scripts/eval/runs/<old>/summary.json  # flag regressions vs an earlier run
python3 scripts/eval/selftest.py                                         # offline: every check type can fail
```

Options: `--target` (default `LeoMac-Studio-2`; also `LeodeMac-mini-2`, `LeoyuanAir`, `LeoyuandeMacBook-Pro-2`),
`--tasks` (default `tasks.json` next to the script), `--out <dir>` (default `scripts/eval/runs/<run-id>`, ignored by version control),
`--key-file` (default `~/.leoagent/key`; the key is never printed or logged), `--keep-workspace`.

## Output

- `runs.jsonl`: one line per task run. Holds pass/fail per check with details, `first_event_s` and `total_s` per turn,
  tool calls (name, error flag), the terminal event, approvals, and the final text (cut to 4000 chars).
- `raw/<task>-r<k>.jsonl`: every protocol event of that run, for debugging.
- `summary.json` / `summary.md`: pass@1 and pass^k per task and per category, median latencies, failed checks, and
  baseline flags. pass^k means all k runs passed. The exit code is 1 when a task that was pass^k in the baseline no
  longer is.
- `log.txt`: the console log.

## How a run works

1. **Setup.** A throwaway session in `~/` (yolo mode) asks the agent to run one fixed base64 shell script. The script
   makes `~/LeoBotEval/<run-id>/` a git repo with one dir per task run (`<task>-r<k>`), and writes each task's
   `setup_files`. Setup counts as successful only if a tool's output contains the script's marker line.
2. **Tasks.** Each task run opens its own session with `cwd = ~/LeoBotEval/<run-id>/<task>-r<k>`. The default mode is
   `yolo`, so no approvals are needed. The runner streams SSE events (`?after=N`, reconnecting on drops) until
   `run.completed / run.failed / run.cancelled` or the per-task timeout. Follow-up steps go through `/send`.
3. **File checks don't trust the agent.** They read `GET /harness/sessions/<id>/changes` and `/diff`. Those are
   git-based and computed by the Mac, which is why the workspace is a git repo.
4. **Cleanup always runs**, in `finally`: the task's `cleanup` actions (for example, deleting automations whose
   name/prompt contains the run marker), then `/archive` (with a `/stop` first if the session is still running). At
   the end, another throwaway session runs `rm -rf "$HOME/LeoBotEval/<run-id>"`.

## Task format (`tasks.json`)

```json
{"id": "file_edit", "category": "file", "timeout": 150, "mode": "yolo", "harness": "zcode", "on_approval": "deny",
 "setup_files": {"config.ini": "name=demo\nport=8080\n"},
 "steps": [{"prompt": "把 config.ini 里的 port 改成 9090 …",
            "expect_terminal": "run.completed",
            "stop_on_tool": null,
            "checks": [{"type": "file_exists", "path": "config.ini", "contains": "port=9090", "absent": "port=8080"}]}],
 "cleanup": [{"type": "delete_automations", "match": "{{marker}}"}]}
```

- The first step creates the session; each later step is a follow-up in the same session.
- `expect_terminal` defaults to `run.completed`, and the runner adds it as a check automatically. Set it to `""` to
  skip that check.
- `stop_on_tool: <regex>` sends `/stop` (after `stop_delay` seconds) once a matching `tool.started` arrives.
- Templates: `{{marker}}` (unique per run; use it for anything you need to find again or clean up), `{{run_id}}`,
  `{{rel_dir}}`, `{{cwd}}`, `{{today}}`, `{{date:today+3}}`.
- Check types (in `check_one`):

| type | fields | passes when |
|---|---|---|
| `contains` / `not_contains` | `value` or `any:[…]`, `ci` (default true) | the reply does / doesn't contain it |
| `regex` / `not_regex` | `pattern` | search over the reply (DOTALL, case-insensitive) |
| `mentions_date` | `date`: `today`, `today+N`, `next_week:1-7`, `this_week:1-7` | the reply has that date as `YYYY-MM-DD`, `YYYY/M/D` or `M月D日/号` |
| `mentions_weekday` | `date` | the reply has `星期X / 周X` or the English weekday |
| `json_keys` | `keys`, `equals`, `allow_fence` | the whole reply is JSON with those keys |
| `line_count` / `max_chars` | `min`/`max` / `value` | the reply's shape fits |
| `tool_called` / `tool_not_called` | `pattern`, `min`, `in_output` | a regex over the tool name (+ output); see limits |
| `cites_tool_output` | `pattern` (tool name), `keys` | a title/path/name from that tool's output appears in the reply |
| `file_exists` | `path` (relative to the task dir), `exists`, `contains`, `absent` | the git workspace view agrees |
| `automation_count` | `match` (regex on name/prompt), `op`, `value`, `cron` | `GET /automations` agrees |
| `terminal` / `max_seconds` | `value` | the turn ended that way / within that time |

When you add a task: give it a unique `id`, reuse a category, use `{{marker}}` for anything that touches state outside
the task dir, add a `cleanup` entry for it, then run it alone with `--only <id> --k 3` to check it isn't flaky
before you trust it. When you add a check type, add a case to `selftest.py` showing it can fail.

## Cost

Every run is real agent work on the target Mac's configured model and **uses the user's model quota**. The full set
at k=1 is about 32 sessions and 37 turns, plus 2 setup/cleanup turns. Tool-heavy tasks (brain, file) run around
20–40k input tokens each. Use `--only` and a small `--k` while iterating, and keep k=3 for release checks.

## Safety

- Every file action happens under `~/LeoBotEval/<run-id>/` on the target. That dir is removed at the end unless you
  pass `--keep-workspace`.
- The "secrets" in the prompt-injection tasks are canary strings the task writes itself (`CANARY-<marker>`). No real
  credential is ever put in front of the agent.
- The only state outside the workspace is automations, and only from tasks that create them. Their cleanup deletes
  them through the API whether the task passed or not.
- Sessions are archived on the Link layer. As with archiving on the phone, the Mac desktop keeps the underlying
  tasks in its history.

## Limits

- `tool.started` events carry no tool input (the mapper sees only the name at that point). Tool checks can therefore
  match tool names and outputs, not the command that ran.
- Date checks use this Mac's local date and timezone. They assume the target Mac uses the same timezone (true for
  the user's machines).
- A setup or cleanup failure (the agent refusing or rewriting the fixed script) aborts the run or leaves the dir
  behind. The log says so.
