#!/bin/sh
# Studio 自建 runner 的硬边界(ACTIONS_RUNNER_HOOK_JOB_STARTED):公开仓库里 workflow 文件里的 `if:` 可以被
# fork PR 改掉,不算边界。这里在 runner 本机判定 —— 只放行本仓库 main 上的 push / 手动触发 / 定时,
# 其余(pull_request、pull_request_target、别的仓库)一律在任何步骤执行前拒绝。
# 安装:复制到 ~/actions-runner-leobot/leo-job-guard.sh,并在 .env 写
#   ACTIONS_RUNNER_HOOK_JOB_STARTED=/Users/leoyuan/actions-runner-leobot/leo-job-guard.sh
repo=${GITHUB_REPOSITORY:-}; event=${GITHUB_EVENT_NAME:-}; ref=${GITHUB_REF:-}
if [ "$repo" != "leoyb1010/LeoPhoneAgent" ]; then echo "leo-job-guard: refuse repo '$repo'" >&2; exit 1; fi
case "$event" in
  push) [ "$ref" = "refs/heads/main" ] || { echo "leo-job-guard: refuse push to '$ref'" >&2; exit 1; } ;;
  workflow_dispatch|schedule) ;;
  *) echo "leo-job-guard: refuse event '$event'" >&2; exit 1 ;;
esac
echo "leo-job-guard: allow $event $ref"
