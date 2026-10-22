#!/bin/sh
# [up-b-ci] 发版前查 CI:当前 HEAD 提交在 GitHub「LeoPhoneAgent Quality」工作流的结论。
#
# 用法:
#   scripts/LeoCIStatus.sh            # 只打印 PASS / FAIL / PENDING / UNKNOWN,退出码恒 0
#   scripts/LeoCIStatus.sh --gate     # 发版闸门:FAIL 退出 1(LEO_CI_GATE=warn 时只警告放行);
#                                     #   PENDING / UNKNOWN 大声警告但放行(离线也能发版)
#   scripts/LeoCIStatus.sh --sha <提交>  # 查指定提交(默认 git HEAD)
#
# 判定:取该提交最新一次运行。success → PASS;failure / cancelled / timed_out /
# startup_failure / action_required → FAIL;没网 / 没 gh 也没 curl → UNKNOWN。
# [up3-relay-scripts] 真实发版链里发版提交还没 push(或 CI 还在跑),只看它自己永远判不出红:
#   - 运行未完成:再查它的 job,已结束的 job 里有不是 success / skipped 的 → FAIL;
#   - 自己没有已完成的运行:沿 git rev-list --first-parent 找最近一个有结论的祖先,
#     红 → FAIL,绿 → PASS(注明是祖先的结论);找不到才 PENDING / UNKNOWN 放行;
#   - 工作区有未提交改动时警告(包里有 CI 没见过的代码)。
# 先走 gh(带登录态,不吃匿名限流),失败再走匿名 REST(仓库是公开的)。
# 反向验证:scripts/LeoCIStatusTests.sh(PATH 前塞假 gh,祖先红 → 退出 1,绿 → 0)。
set -u

repo="${LEO_CI_REPO:-leoyb1010/LeoPhoneAgent}"
workflow="${LEO_CI_WORKFLOW:-ios-tests.yml}"
gate=0
sha=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --gate) gate=1 ;;
    --sha) shift; sha="${1:-}" ;;
    *) echo "LeoCIStatus: 未知参数 $1" >&2; exit 2 ;;
  esac
  shift
done
explicit_sha="$sha"

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# head_sha 过滤只认完整 40 位,短 sha / 分支名先解析。
sha=$(git -C "$repo_root" rev-parse --verify "${sha:-HEAD}^{commit}" 2>/dev/null || printf '%s' "$sha")

# 没有 timeout 命令的 macOS 上用 perl alarm 给网络调用封顶,断网时不会卡住发版。
limit() { perl -e 'alarm shift; exec @ARGV or exit 127' "$@"; }

# GET 一个 GitHub API 路径,失败输出空。
api() {
  out=""
  if command -v gh >/dev/null 2>&1; then
    out=$(limit 20 gh api "$1" 2>/dev/null) || out=""
  fi
  if [ -z "$out" ] && command -v curl >/dev/null 2>&1; then
    out=$(curl -fsS --max-time 15 -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/$1" 2>/dev/null) || out=""
  fi
  printf '%s' "$out"
}

have_py=0
command -v python3 >/dev/null 2>&1 && have_py=1

status=UNKNOWN
detail="查不到 CI 结果(没网 / 没 gh 和 curl / 提交没 push 或没触发工作流)"
run_id=""
json=""
[ -n "$sha" ] && json=$(api "repos/$repo/actions/workflows/$workflow/runs?head_sha=$sha&per_page=20")
if [ -n "$json" ] && [ "$have_py" -eq 1 ]; then
  # 输出 状态<TAB>说明<TAB>未完成的 run id(可空)。NORUNS = 查到了,但这个提交没有运行。
  result=$(printf '%s' "$json" | python3 -c '
import json, sys
try:
    runs = json.load(sys.stdin).get("workflow_runs") or []
except Exception:
    print("UNKNOWN\tGitHub 返回的不是可解析的 JSON\t"); raise SystemExit
if not runs:
    print("NORUNS\t这个提交还没有工作流运行(没 push,或改动不在触发路径里)\t"); raise SystemExit
run = max(runs, key=lambda r: r.get("created_at") or "")
where = "run %s %s" % (run.get("id"), run.get("html_url") or "")
if run.get("status") != "completed":
    print("PENDING\t%s 还在跑(%s)\t%s" % (where, run.get("status"), run.get("id") or "")); raise SystemExit
c = run.get("conclusion")
if c == "success":
    print("PASS\t%s\t" % where)
elif c in ("neutral", "skipped"):
    print("UNKNOWN\t%s 结论是 %s\t" % (where, c))
else:
    print("FAIL\t%s 结论是 %s\t" % (where, c))
') || result=""
  if [ -n "$result" ]; then
    status=${result%%"	"*}
    rest=${result#*"	"}
    detail=${rest%"	"*}
    run_id=${rest##*"	"}
  fi
fi

# 还在跑的运行:已经结束的 job 红了就不用等整条跑完。
if [ "$status" = PENDING ] && [ -n "$run_id" ]; then
  jobs=$(api "repos/$repo/actions/runs/$run_id/jobs?per_page=100")
  if [ -n "$jobs" ]; then
    bad=$(printf '%s' "$jobs" | python3 -c '
import json, sys
try:
    jobs = json.load(sys.stdin).get("jobs") or []
except Exception:
    raise SystemExit
print(", ".join("%s=%s" % (j.get("name"), j.get("conclusion")) for j in jobs
                if j.get("status") == "completed" and j.get("conclusion") not in ("success", "skipped")))
') || bad=""
    if [ -n "$bad" ]; then
      status=FAIL
      detail="$detail,已结束的 job 里有红的:$bad"
    fi
  fi
fi

# 自己没有结论:看它所基于的代码 —— first-parent 上最近一个有结论的祖先。
if { [ "$status" = PENDING ] || [ "$status" = NORUNS ]; } && [ "$have_py" -eq 1 ]; then
  ancestors=$(git -C "$repo_root" rev-list --first-parent --max-count=200 "$sha" 2>/dev/null | sed 1d)
  if [ -n "$ancestors" ]; then
    completed=$(api "repos/$repo/actions/workflows/$workflow/runs?status=completed&per_page=100")
    if [ -n "$completed" ]; then
      result=$(printf '%s' "$completed" | python3 -c '
import json, sys
try:
    runs = json.load(sys.stdin).get("workflow_runs") or []
except Exception:
    raise SystemExit
latest = {}
for r in runs:
    s = r.get("head_sha")
    if s and (s not in latest or (r.get("created_at") or "") > (latest[s].get("created_at") or "")):
        latest[s] = r
for s in sys.argv[1].split():
    r = latest.get(s)
    if not r or r.get("conclusion") in ("neutral", "skipped"):
        continue
    where = "祖先 %s 的 run %s %s" % (s[:8], r.get("id"), r.get("html_url") or "")
    if r.get("conclusion") == "success":
        print("PASS\t%s 是绿的" % where)
    else:
        print("FAIL\t%s 结论是 %s" % (where, r.get("conclusion")))
    break
' "$ancestors") || result=""
      if [ -n "$result" ]; then
        own="$detail"
        status=${result%%"	"*}
        detail="HEAD 自己还没有结论($own),按最近有结论的${result#*"	"}"
      fi
    fi
  fi
fi
[ "$status" = NORUNS ] && status=UNKNOWN

short=$(printf '%.8s' "$sha")
echo "LeoCIStatus: $status  ($repo $workflow @ ${short:-?}) $detail"
if [ -z "$explicit_sha" ] && [ -n "$(git -C "$repo_root" status --porcelain 2>/dev/null | head -1)" ]; then
  echo "!!!!!! LeoCIStatus: 工作区有未提交的改动 —— 打出来的包里有 CI 没见过的代码 !!!!!!" >&2
fi
[ "$gate" -eq 1 ] || exit 0

case "$status" in
  PASS) exit 0 ;;
  FAIL)
    if [ "${LEO_CI_GATE:-}" = "warn" ]; then
      echo "!!!!!! LeoCIStatus: CI 是红的,LEO_CI_GATE=warn 显式放行 —— 发版说明里写清原因 !!!!!!" >&2
      exit 0
    fi
    echo "LeoCIStatus: CI 是红的,发版被挡。先修 CI(若 HEAD 就是修复,等它的 CI 跑绿);确需带红发版用 LEO_CI_GATE=warn 显式放行。" >&2
    exit 1 ;;
  *)
    echo "!!!!!! LeoCIStatus: CI 状态 $status —— 没法确认这个提交是绿的,继续发版但请事后核对 !!!!!!" >&2
    exit 0 ;;
esac
