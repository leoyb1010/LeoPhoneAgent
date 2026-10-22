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

## 中继冷备(mini 整机不可用时)

每天的 restic 备份会再 rsync 一份到 Studio `~/Backups/leo-relay-restic`(密码同 mini 的 `~/.config/leo-relay/restic-password`,另存一份在你的密码管理器)。切到 Studio:

1. Studio 上恢复(restic 在 `~/bin/restic`,Studio 的 brew 连不上 GitHub,从 mini 拷的同版本二进制):`~/bin/restic -r ~/Backups/leo-relay-restic --password-file <pw> restore latest --tag leo-relay --target /tmp/r && cp -R /tmp/r/Users/leo/.leoagent ~/.leoagent-relay`
2. 用仓库里的 `src/mac/leoagent` 起中继:`RELAY_KEY=… python3 -m leoagent.relay --port 8650`(依赖 aiohttp;state 路径指向恢复出的目录)
3. 把 Cloudflare 隧道 `relay.leoyuan.top` 的 connector 换到 Studio(Cloudflare 后台或在 Studio 上用同一隧道凭据起 cloudflared)。
4. mini 恢复后反向同步 `~/.leoagent` 再切回。手机端地址不变,无需重新配对(设备钥匙、钉扎都在备份里)。
