#!/bin/sh
set -u

# 性能预算闸门(InstallIOSRelease.sh 第 2 步调用)。用法:
#   ./scripts/IOSPerfGateFromDevice.sh <UDID>     # 从真机拉当前已装版本的 perf.jsonl + 最新日志
#   LEO_PERF_DIR=<dir> ./scripts/IOSPerfGateFromDevice.sh   # 用已有数据(dir 里放 perf.jsonl + day.log)
#
# 新版本装上之前,设备上只有"上一版"的性能数据,所以这里判的是当前已装版本:
# 上一版超预算就先挡住,修好再装。若这次装的正是性能修复,显式放行:
#   LEO_PERF_GATE=warn ./scripts/InstallIOSRelease.sh
# 拉不到数据(未装 App、设备锁屏、没有 python3)时打印 "SKIPPED: no perf data",绝不静默通过。
# 只用系统自带工具:/bin/sh、xcrun devicectl、python3(/usr/bin/python3 即可)。

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
bundle_id="com.leoyuan.leophoneagent"
mode="${LEO_PERF_GATE:-block}"

skip() {
  echo "    !!! SKIPPED: no perf data — $1"
  echo "    !!! 性能预算闸门本次没有评估任何预算(这不是通过)。"
  exit 0
}

if [ -n "${LEO_PERF_DIR:-}" ]; then
  dir="$LEO_PERF_DIR"
else
  udid="${1:-}"
  [ -n "$udid" ] || skip "没有可拉取数据的 iPhone/iPad"
  dir="$HOME/Library/Developer/LeoBot-perf/$udid"
  mkdir -p "$dir" || skip "无法创建 $dir"
  rm -f "$dir/perf.jsonl" "$dir/day.log"
  dc() { xcrun devicectl device "$@" --device "$udid" \
    --domain-type appDataContainer --domain-identifier "$bundle_id" >/dev/null 2>&1; }
  dc copy from --source "Library/Application Support/Diagnostics/perf.jsonl" --destination "$dir/perf.jsonl" \
    || skip "无法从 $udid 拉取 perf.jsonl(未安装 App 或设备不可用)"
  latest_log=$(xcrun devicectl device info files --device "$udid" --domain-type appDataContainer \
      --domain-identifier "$bundle_id" --subdirectory Library/Logs 2>/dev/null \
    | grep -oE 'minis-[0-9]{4}-[0-9]{2}-[0-9]{2}\.log' | sort | tail -1)
  [ -n "$latest_log" ] || skip "设备 $udid 上没有 Library/Logs/minis-*.log"
  dc copy from --source "Library/Logs/$latest_log" --destination "$dir/day.log" \
    || skip "无法从 $udid 拉取 $latest_log"
  echo "    数据: $dir (perf.jsonl + $latest_log)"
fi

[ -s "$dir/perf.jsonl" ] || skip "$dir/perf.jsonl 不存在或为空"
[ -s "$dir/day.log" ] || skip "$dir/day.log 不存在或为空"
command -v python3 >/dev/null 2>&1 || skip "PATH 里没有 python3"

report=$(mktemp -t leo-perf-gate) || skip "mktemp 失败"
python3 "$repo_root/scripts/IOSPerfBudgetGate.py" --perf "$dir/perf.jsonl" --log "$dir/day.log" >"$report" 2>&1
rc=$?
sed 's/^/    /' "$report"
[ "$rc" -eq 0 ] && exit 0
# 退出码 1 是预算 FAIL;其他(脚本崩溃等)也按失败处理,不能当通过。
grep -q '^RESULT: FAIL' "$report" || echo "    IOSPerfBudgetGate 异常退出(rc=$rc)" >&2
if [ "$mode" = "warn" ]; then
  echo "    !!! OVERRIDDEN: 性能预算 FAIL,但 LEO_PERF_GATE=warn 显式放行。"
  exit 0
fi
echo "    性能预算 FAIL:先修性能;若本次装的就是性能修复,用 LEO_PERF_GATE=warn 显式放行。" >&2
exit 1
