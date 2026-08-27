# leocodebox 1.77.0

## 本次交付

- Claude Code 跑到一半，提问卡缺 `options`、Edit/Write 的 `old_string`/`new_string` 为空、或大文件 diff 走 LCS 爆表，不再把整块聊天换成「此区域暂时无法加载」。
- 消息区和输入框分开兜底；换会话会自动恢复。
- 随包「本次更新」写的就是这一版。

## 发布边界

Developer ID Application 签名后上传 `leocodebox-updates`（`v1.77.0` + `latest-mac.yml` + ZIP + DMG）。本机钥匙串没有 `leocodebox` 公证 profile，本版不 stapler。热更新仍走同一 TeamIdentifier。本机 `/Applications` 只留这一份。
