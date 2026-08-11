# leocodebox 1.40.1

## 这一版你多了什么

- **CLI 更新不再"假"**：状态与一键更新现在锚定 PATH 首位、也就是你终端实际运行的那份 CLI。此前若机器上存在多份同名 CLI（例如 nvm 多版本 + homebrew npm 各装一份 claude），App 会更新到你不用的那份，终端里版本纹丝不动。
- **多副本透明化**：同名 CLI 存在多份时，工具卡片显示琥珀色提示（副本数与版本分布），悬停可见每份的路径、版本与来源；更新后明确告知更新的是哪一份。
- **npm 更新定向**：npm 全局更新自动附加 `--prefix=<副本所属前缀>`，保证写入你正在用的那套 node，而不是服务器环境里碰巧排在前面的那套。
- **原生安装识别**：直接落在 /opt/homebrew/bin、/usr/local/bin 等目录的原生自更新二进制正确识别为 standalone，并按其绝对路径执行自更新。
- **报错说人话**：Cursor Agent 自更新需要登录态时给出明确指引；npm allow-scripts 拦截安装脚本时显式告知补救命令。

## 验证

- 桌面、前端与服务端自动化测试全部通过（服务端新增 3 项副本锚定测试）。
- TypeScript、ESLint（0 警告）、生产构建通过。
- 在真实多副本环境（4 份 claude、3 个版本并存）实测：定向更新命中正确前缀，全部副本收敛至最新。
- macOS App 使用 Developer ID 签名并完成 Apple 公证与装订。

## 下载校验

- DMG SHA-256：`ad88e6184fab810ca3d0bf6dc9dae629e56552c824d0e66ce112ed8bf338906e`
- ZIP SHA-256：`81bfa5534ba8e5be3de6144ce1a1c2e07d6695ef5fd18359aa2acf28f5a835c9`
- `latest-mac.yml` SHA-256：`3176b65039d0bb20a9432d4ee0786af88f9dcc77d7ba8bc5ed770c26884600eb`
