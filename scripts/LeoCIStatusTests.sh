#!/bin/sh
# [up3-relay-scripts] LeoCIStatus.sh --gate 的反向验证:PATH 前塞一个假 gh,按场景返回运行 / job JSON,
# 在临时 git 仓库里跑闸门,断言退出码。不联网。用法:sh scripts/LeoCIStatusTests.sh
set -u

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/leocistatus-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

repo="$tmp/repo"
mkdir -p "$repo/scripts" "$tmp/bin" "$tmp/fake"
cp "$here/LeoCIStatus.sh" "$repo/scripts/LeoCIStatus.sh"
git -C "$repo" init -q
git -C "$repo" config user.email ci-test@example.invalid
git -C "$repo" config user.name ci-test
for n in 1 2 3; do
  echo "$n" > "$repo/f.txt"
  git -C "$repo" add -A
  git -C "$repo" commit -qm "c$n"
done
head=$(git -C "$repo" rev-parse HEAD)
parent=$(git -C "$repo" rev-parse HEAD~1)
grand=$(git -C "$repo" rev-parse HEAD~2)

cat > "$tmp/bin/gh" <<'EOF'
#!/bin/sh
# gh api <path>
case "$2" in
  *head_sha=*) cat "$FAKE_DIR/head.json" ;;
  */jobs*) cat "$FAKE_DIR/jobs.json" ;;
  *status=completed*) cat "$FAKE_DIR/completed.json" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/gh"

run() { printf '{"id":%s,"head_sha":"%s","status":"%s","conclusion":%s,"created_at":"%s"}' "$1" "$2" "$3" "$4" "$5"; }
setup() {  # head.json jobs.json completed.json
  printf '%s' "$1" > "$tmp/fake/head.json"
  printf '%s' "$2" > "$tmp/fake/jobs.json"
  printf '%s' "$3" > "$tmp/fake/completed.json"
}

failures=0
expect() {  # 期望退出码 场景名 [额外环境]
  want=$1; name=$2; shift 2
  out=$(env PATH="$tmp/bin:$PATH" FAKE_DIR="$tmp/fake" "$@" sh "$repo/scripts/LeoCIStatus.sh" --gate 2>&1)
  got=$?
  if [ "$got" -eq "$want" ]; then
    echo "ok   $name (exit $got)"
  else
    echo "FAIL $name: want exit $want, got $got"; echo "$out" | sed 's/^/     /'
    failures=$((failures + 1))
  fi
}

none='{"workflow_runs":[]}'
nojobs='{"jobs":[]}'

# 发版提交没 push,最近有结论的祖先是红的 → 挡。
setup "$none" "$nojobs" "{\"workflow_runs\":[$(run 2 "$parent" completed '"failure"' 2026-01-02T00:00:00Z),$(run 1 "$grand" completed '"success"' 2026-01-01T00:00:00Z)]}"
expect 1 "HEAD 没运行,父提交红"
expect 0 "HEAD 没运行,父提交红,LEO_CI_GATE=warn 放行" LEO_CI_GATE=warn

# 父提交没跑(路径过滤),祖父绿 → 放行。
setup "$none" "$nojobs" "{\"workflow_runs\":[$(run 1 "$grand" completed '"success"' 2026-01-01T00:00:00Z)]}"
expect 0 "HEAD 没运行,最近有结论的祖先绿"

# 父提交的运行被取消(不是结论),祖父红 → 挡。
setup "$none" "$nojobs" "{\"workflow_runs\":[$(run 2 "$parent" completed '"cancelled"' 2026-01-02T00:00:00Z),$(run 1 "$grand" completed '"failure"' 2026-01-01T00:00:00Z)]}"
expect 1 "父提交取消,祖父红"

# 父提交同一 sha 先红后重跑绿:取最新那次 → 放行。
setup "$none" "$nojobs" "{\"workflow_runs\":[$(run 3 "$parent" completed '"success"' 2026-01-03T00:00:00Z),$(run 2 "$parent" completed '"failure"' 2026-01-02T00:00:00Z)]}"
expect 0 "父提交重跑后转绿"

# HEAD 自己还在跑,但已结束的 job 有红的 → 挡(不看祖先)。
setup "{\"workflow_runs\":[$(run 9 "$head" in_progress null 2026-01-04T00:00:00Z)]}" \
  '{"jobs":[{"name":"ios-static-audits","status":"completed","conclusion":"failure"},{"name":"ios-unit-tests","status":"in_progress","conclusion":null}]}' \
  "{\"workflow_runs\":[$(run 1 "$parent" completed '"success"' 2026-01-01T00:00:00Z)]}"
expect 1 "HEAD 在跑,已有 job 红"

# HEAD 在跑,已结束的 job 都绿/跳过,祖先红 → 挡。
setup "{\"workflow_runs\":[$(run 9 "$head" in_progress null 2026-01-04T00:00:00Z)]}" \
  '{"jobs":[{"name":"a","status":"completed","conclusion":"success"},{"name":"b","status":"completed","conclusion":"skipped"},{"name":"c","status":"queued","conclusion":null}]}' \
  "{\"workflow_runs\":[$(run 1 "$parent" completed '"failure"' 2026-01-01T00:00:00Z)]}"
expect 1 "HEAD 在跑没红 job,父提交红"

# 同上但祖先绿 → 放行。
setup "{\"workflow_runs\":[$(run 9 "$head" in_progress null 2026-01-04T00:00:00Z)]}" \
  '{"jobs":[{"name":"a","status":"completed","conclusion":"success"}]}' \
  "{\"workflow_runs\":[$(run 1 "$parent" completed '"success"' 2026-01-01T00:00:00Z)]}"
expect 0 "HEAD 在跑没红 job,父提交绿"

# HEAD 自己有结论:直接按它判(祖先红也不影响)。
setup "{\"workflow_runs\":[$(run 9 "$head" completed '"success"' 2026-01-04T00:00:00Z)]}" "$nojobs" \
  "{\"workflow_runs\":[$(run 1 "$parent" completed '"failure"' 2026-01-01T00:00:00Z)]}"
expect 0 "HEAD 自己绿"
setup "{\"workflow_runs\":[$(run 9 "$head" completed '"failure"' 2026-01-04T00:00:00Z)]}" "$nojobs" "$none"
expect 1 "HEAD 自己红"

# 一个有结论的祖先都找不到 → UNKNOWN 放行(离线也能发版的老口径)。
setup "$none" "$nojobs" "$none"
expect 0 "HEAD 和祖先都没结论"

# 工作区脏:警告。
echo dirty > "$repo/untracked.txt"
setup "{\"workflow_runs\":[$(run 9 "$head" completed '"success"' 2026-01-04T00:00:00Z)]}" "$nojobs" "$none"
if env PATH="$tmp/bin:$PATH" FAKE_DIR="$tmp/fake" sh "$repo/scripts/LeoCIStatus.sh" --gate 2>&1 | grep -q "未提交的改动"; then
  echo "ok   工作区脏时警告"
else
  echo "FAIL 工作区脏时没有警告"; failures=$((failures + 1))
fi

[ "$failures" -eq 0 ] && echo "LeoCIStatusTests: all passed" || echo "LeoCIStatusTests: $failures failed"
[ "$failures" -eq 0 ]
