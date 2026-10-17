# Mac mini coturn(看屏 R1 的 STUN / TURN)

LeoBot 的 WebRTC 看屏(WP-51)按 **tailnet → 局域网 → STUN 打洞 → Mac mini coturn 中转** 的顺序选路。
前三种不需要任何服务器;只有手机既不在 Tailscale 上、又和 Mac 不在同一个局域网、打洞也失败时,才用到这里部署的中转。
视频从不经过 relay(relay 只传信令)。契约见 `src/mac/leophone/docs/specs/leo-screen.md`。

## 部署(在 Mac mini 上手动执行)

```bash
cd ~/leophone-mac/src/mac/leoagent/turn
./install-coturn.sh install --external-ip <公网IP>/<Mac mini 内网IP> --host <对外域名或公网IP>
```

脚本会:

1. `brew install coturn`(已装则跳过);
2. 生成共享密钥 `~/.leoagent/turn/secret`(0600,不打印);
3. 写 `$(brew --prefix)/etc/turnserver.conf`:`use-auth-secret` 短期凭据、端口 3478、中转端口 49160–49200、
   每用户 4 路 / 总 16 路配额、禁止中转到内网 / 回环 / 链路本地 / Tailscale 网段;原有配置先备份;
4. 生成给各台 Mac 用的 `~/.leoagent/turn/turn.json`(0600);
5. `brew services restart coturn`(launchd 常驻,开机自启)。

路由器要把 **UDP 3478、TCP 3478、UDP 49160–49200** 转发到 Mac mini。

其它子命令:`status`(服务状态与最近日志)、`verify --host <对外地址>`(STUN 探测 + 用 10 分钟凭据跑一次中转自检)、
`uninstall`(停服务,保留配置与密钥)。

## 各台 Mac 的配置

把 Mac mini 上生成的 `~/.leoagent/turn/turn.json` 复制到每台装 LeoBot 的 Mac:

```bash
install -m 600 turn.json ~/.leoagent/link/turn.json
```

格式:

```json
{
  "urls": ["stun:<host>:3478", "turn:<host>:3478?transport=udp", "turn:<host>:3478?transport=tcp"],
  "secret": "<共享密钥>",
  "ttl_seconds": 3600
}
```

LeoBot 每次建看屏会话时用它签一组短期凭据(TURN REST:`username = "<过期 unix 秒>:leobot"`,
`credential = base64(HMAC-SHA1(secret, username))`),随 `POST /screen/session` 的 `ice_servers` 发给手机。
手机拿不到共享密钥本身;凭据默认 1 小时过期(`ttl_seconds` 可设 300–86400)。

没有这个文件时 `ice_servers` 为空:只走 tailnet / 局域网直连。Mac 设置里打开「只走 Tailscale」时也不下发中转。

## 安全

- 共享密钥只在 Mac mini 与各台 Mac 的 0600 文件里;泄漏后重新生成:删掉 `~/.leoagent/turn/secret` 再跑一次 `install`,
  并把新的 `turn.json` 发到各台 Mac。
- `denied-peer-ip` 挡住 10/8、172.16/12、192.168/16、100.64/10、127/8、169.254/16 及 IPv6 私网:
  中转只能连公网地址,不能被当成进内网的跳板。
- 不开 coturn 的 CLI(`no-cli`)、不开 TLS 1.0/1.1。需要 `turns:`(TLS 443)时另行配置证书,再把 URL 加进 `turn.json`。
