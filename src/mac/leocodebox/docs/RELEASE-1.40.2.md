# leocodebox 1.40.2

## 这一版你多了什么

- **只看你终端里的那份**：CLI 副本发现改用你 login shell 的 PATH（由桌面外壳捕获传入），App 服务进程自己增强 PATH 里那些你终端根本解析不到的副本（例如其他 nvm node 版本下的安装）不再被列出、不再做参考。
- **提示降噪**：多副本提示只在「你终端 PATH 里的副本版本不一致」时才显示——那是唯一会造成"更新了看不到"的情形；版本一致时界面保持安静。
- 兜底：某个 CLI 不在你 shell PATH 里时，回退到全局探测，检测能力不低于旧版。

## 验证

- 服务端 189 项测试全部通过（新增副本发现遵循用户 shell PATH 的专项测试）。
- TypeScript、ESLint（0 警告）、生产构建通过。
- macOS App 使用 Developer ID 签名并完成 Apple 公证与装订。

## 下载校验

- DMG SHA-256：`cc523a43cb184773474ba5677acc8367e89989811be094aa76075b49b89290c7`
- ZIP SHA-256：`af73bea98ecc3fc44da2f335d4afbba6a4c0007588800e4b6b4f71c3d435dea7`
- `latest-mac.yml` SHA-256：`9affebc2a51eab038fb6593ec4394eeab2676144362456db97703007dff248be`
