# leocodebox 1.74.2

## 本次交付

- 升级 `node-gyp`、`postcss`、`sharp` 及安全修复后的传递依赖。
- `npm audit`（含开发依赖）与 `npm audit --omit=dev`（正式运行依赖）均为 0 漏洞。
- 修正主仓嵌套目录的 Husky 安装路径，`npm install` 会把钩子落到 LeoPhoneAgent 仓库根，不再静默跳过。
- 更新随包内置的「本次更新」记录与源码版本。

## 发布边界

公开热更新必须同时满足 Developer ID Application 签名、Apple 公证、Stapler 钉章、Gatekeeper 验证和更新 ZIP 签名连续性。本机没有对应 Developer ID 私钥时，只允许生成本机验证包，禁止上传到 `leocodebox-updates`。
