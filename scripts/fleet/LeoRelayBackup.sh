#!/bin/zsh
# 每日备份 ~/.leoagent(中继身份 / 排队 / 藏宝阁同步 / 资产),保留 14 天 + 8 周。
# 仓库在 mini 外接盘;密码文件 0600。restore 演练:
#   restic -r $REPO --password-file $PW restore latest --tag leo-relay --target /tmp/relay-restore
set -euo pipefail
REPO=${LEO_RELAY_RESTIC_REPO:-/Volumes/Leo-bubu/Mac-Offload/Backups/leo-relay-restic}
PW=${LEO_RELAY_RESTIC_PASSWORD_FILE:-$HOME/.config/leo-relay/restic-password}
RESTIC=/opt/homebrew/bin/restic
echo "== $(date '+%F %T') backup"
[ -d "$REPO" ] || $RESTIC -r "$REPO" --password-file "$PW" init
$RESTIC -r "$REPO" --password-file "$PW" backup "$HOME/.leoagent" --tag leo-relay \
  --exclude "$HOME/.leoagent/backup-*" --exclude "$HOME/.leoagent/backups" --exclude "*.tmp" --exclude "__pycache__"
$RESTIC -r "$REPO" --password-file "$PW" forget --tag leo-relay --keep-daily 14 --keep-weekly 8 --prune
# 异机副本:mini 整机坏了备份不能跟着没。restic 仓库是普通文件,备份跑完再 rsync 不会撞上写入。
# 恢复到 Studio 起中继的步骤见 scripts/fleet/README.md「中继冷备」。
OFFSITE=${LEO_RELAY_BACKUP_OFFSITE:-leoyuan@100.116.29.98:Backups/leo-relay-restic}
ssh -o BatchMode=yes -o ConnectTimeout=10 "${OFFSITE%%:*}" "mkdir -p '${OFFSITE#*:}'" \
  && rsync -a --delete -e "ssh -o BatchMode=yes" "$REPO/" "$OFFSITE/" \
  && echo "offsite copy -> $OFFSITE" || echo "offsite copy FAILED -> $OFFSITE" >&2
