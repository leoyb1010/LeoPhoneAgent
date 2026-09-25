# 全面实施状态

目标：完整落实已批准的 iOS 与 Mac 升级方案，W01–W23 持续跟踪，不以首批修复替代完整交付。实现基线 `094d4f8c`。工作状态与验收证据见 `implementation-state.json`。

## 实施前事实修正

再次追踪真实调用链确认：手电筒并非完全缺失。`src/ios/Agent/Chat/AIChatViewModel+Misc.swift:508` 已有 `FastLocalActions.setTorch`，`executeNativeRoute` 和 `ContentView.swift:1628` 均可调用；`AgentChatCorrectness.swift` 已有中英文明确开关指令识别。此前审计只覆盖 NativeOffloads 注册目录，漏掉这条直接路径，“手电筒完全未接入”的结论不成立。

W07 保留并深化既有实现：动作级授权、可用性与实际状态、亮度、取消和前后台，以及 CLI、自然语言、主页和系统入口共用服务。W01 必须覆盖直接原生动作，不仅覆盖 iSH 的 C 注册 handler。

## 当前证据

结果模型回归 RED：新结果契约尚不存在时编译失败，exit 65。GREEN：15 项结果模型测试通过，exit 0。日志在 `outputs/implementation-2026-09-12/ios-outcome/`。

iOS 1.35.0 (110) 已完成本次本机能力、任务回执接线与 Wi-Fi iPhone 安装；390 项逻辑测试通过，设备版本回读及启动通过。详见 [本次 iPhone 交付记录](IPHONE_1.35.0_DELIVERY.md)。完整 W01–W23、全部真机场景与性能评分尚未完成，Mac 改动尚未作为本次安装交付。
