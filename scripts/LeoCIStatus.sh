#!/bin/sh
# [up-b-ci] 发版前查 CI:当前 HEAD 提交在 GitHub「LeoPhoneAgent Quality」工作流的结论。
#
# 用法:
#   scripts/LeoCIStatus.sh            # 只打印 PASS / FAIL / PENDING / UNKNOWN,退出码恒 0
#   scripts/LeoCIStatus.sh --gate     # 发版闸门:FAIL 退出 1(LEO_CI_GATE=warn 时只警告放行);
#                                     #   PENDING / UNKNOWN 大声警告但放行(离线也能发版)
#   scripts/LeoCIStatus.sh --sha <提交>  # 查指定提交(默认 git HEAD)
#
# 判定:取该提交最新一次运行。未完成 → PENDING;success → PASS;failure / cancelled /
# timed_out / startup_failure / action_required → FAIL;查不到运行(没 push、路径过滤没触发)
# 或没网 / 没 gh 也没 curl → UNKNOWN。
# 先走 gh(带登录态,不吃匿名限流),失败再走匿名 REST(仓库是公开的)。
# 反向验证:PATH 前塞一个假 gh 输出 conclusion=failure 的 JSON,--gate 必须退出 1。
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

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# head_sha 过滤只认完整 40 位,短 sha / 分支名先解析。
sha=$(git -C "$repo_root" rev-parse --verify "${sha:-HEAD}^{commit}" 2>/dev/null || printf '%s' "$sha")

# 没有 timeout 命令的 macOS 上用 perl alarm 给网络调用封顶,断网时不会卡住发版。
limit() { perl -e 'alarm shift; exec @ARGV or exit 127' "$@"; }

json=""
if [ -n "$sha" ]; then
  path="repos/$repo/actions/workflows/$workflow/runs?head_sha=$sha&per_page=20"
  if command -v gh >/dev/null 2>&1; then
    json=$(limit 20 gh api "$path" 2>/dev/null) || json=""
  fi
  if [ -z "$json" ] && command -v curl >/dev/null 2>&1; then
    json=$(curl -fsS --max-time 15 -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/$path" 2>/dev/null) || json=""
  fi
fi

status=UNKNOWN
detail="查不到 CI 结果(没网 / 没 gh 和 curl / 提交没 push 或没触发工作流)"
if [ -n "$json" ] && command -v python3 >/dev/null 2>&1; then
  result=$(printf '%s' "$json" | python3 -c '
import json, sys
try:
    runs = json.load(sys.stdin).get("workflow_runs") or []
except Exception:
    print("UNKNOWN\tGitHub 返回的不是可解析的 JSON"); raise SystemExit
if not runs:
    print("UNKNOWN\t这个提交还没有工作流运行(没 push,或改动不在触发路径里)"); raise SystemExit
run = max(runs, key=lambda r: r.get("created_at") or "")
where = "run %s %s" % (run.get("id"), run.get("html_url") or "")
if run.get("status") != "completed":
    print("PENDING\t%s 还在跑(%s)" % (where, run.get("status"))); raise SystemExit
c = run.get("conclusion")
if c == "success":
    print("PASS\t" + where)
elif c in ("neutral", "skipped"):
    print("UNKNOWN\t%s 结论是 %s" % (where, c))
else:
    print("FAIL\t%s 结论是 %s" % (where, c))
') || result=""
  [ -n "$result" ] && { status=${result%%"	"*}; detail=${result#*"	"}; }
fi

short=$(printf '%.8s' "$sha")
echo "LeoCIStatus: $status  ($repo $workflow @ ${short:-?}) $detail"
[ "$gate" -eq 1 ] || exit 0

case "$status" in
  PASS) exit 0 ;;
  FAIL)
    if [ "${LEO_CI_GATE:-}" = "warn" ]; then
      echo "!!!!!! LeoCIStatus: CI 是红的,LEO_CI_GATE=warn 显式放行 —— 发版说明里写清原因 !!!!!!" >&2
      exit 0
    fi
    echo "LeoCIStatus: CI 是红的,发版被挡。先修 CI;确需带红发版用 LEO_CI_GATE=warn 显式放行。" >&2
    exit 1 ;;
  *)
    echo "!!!!!! LeoCIStatus: CI 状态 $status —— 没法确认这个提交是绿的,继续发版但请事后核对 !!!!!!" >&2
    exit 0 ;;
esac
