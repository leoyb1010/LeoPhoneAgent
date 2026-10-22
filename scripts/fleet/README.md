# LeoBot 机群运维(P0,2026-10-22)

| 文件 | 装在哪 | 做什么 |
|---|---|---|
| `com.leoyuan.leobot-keepalive.plist` | Studio / mini / Air(MBP 不装) | 每 2 分钟看 LeoBot 是否在跑,没在跑就后台拉起,记 `~/Library/Logs/leobot-keepalive.log` |
| `com.leoyuan.leobot-fleet-doctor.plist` | mini | 每 5 分钟跑 `../LeoFleetDoctor.py --monitor`:中继、三台宿主是否连着、排队、备份新鲜度、磁盘;状态翻转时 ntfy(bubu-ops) |
| `com.leoyuan.leo-relay-backup.plist` + `LeoRelayBackup.sh` | mini | 每天 04:20 restic 备份 `~/.leoagent` 到外接盘,保留 14 天 + 8 周 |
| `com.leoyuan.leo-brain-daily.plist` + `LeoBrainDaily.py` | mini | 每天 08:05 推「大脑每日一页」:一张知识卡(自己写的加权)+ 两条相关资料 |

- mini 上脚本放在 `~/Library/Application Support/LeoBot-fleet/`,plist 里的 `__HOME__` 安装时替换成 `/Users/leo`。
- mini 的 launchd 任务一律用 `/opt/homebrew/bin/python3` 起:`/usr/bin/python3` 没有外接盘的 TCC 授权,restic 会卡住。
- 发 Mac 新版用 `../leo-deploy-mac.sh <dmg> studio,mini,air`(校验 sha256、装完等它以新版本连上中继,失败自动回滚,顺带装常驻守护)。
- 手动看一眼全机群:`python3 scripts/LeoFleetDoctor.py --fleet mbp,studio,mini,air`。
- 备份恢复演练:`restic -r <repo> --password-file ~/.config/leo-relay/restic-password restore latest --tag leo-relay --target /tmp/relay-restore`。
