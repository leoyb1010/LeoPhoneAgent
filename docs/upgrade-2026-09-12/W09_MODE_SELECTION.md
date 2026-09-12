# W09 语音模式选择修复

明确选择 System 自动模式时，旧解析器会因为没有 Online/Offline 后缀而继续读取分组；默认分组又以 Online 开头，因此明确的自动选择可能被改成联网许可。

本轮让明确的 System 选择完整覆盖分组，包括旧版 System sentinel、system-asr 和 input 等自动模式标识。分组按顺序处理第一个 System 成员，不再跳过自动成员；其他 Provider 的相似模型 ID 不影响 System 政策。

新建默认语音输入分组仅包含 System 自动模型，联网回退仍由资源页中的明确偏好控制。已有分组不被迁移或重写；已配置为 Online 的分组保持原来的联网许可，用户仍可明确切换到 Auto 或 Offline。

`scripts/IOSSystemSpeechSelectionSmoke.py` 提取并执行实际模式解析和默认分组创建方法，使用隔离的偏好与分组替身，不读取或改写用户配置。修复前复现自动选择被 Online 覆盖；修复后覆盖明确 Auto/Offline/Online、分组顺序、Provider 身份、新默认值、幂等创建与已有配置保留，全部通过。generic iOS 设备目标构建和 diff 检查通过。

证据：`outputs/implementation-2026-09-12/ios-speech-selection/`。这是源码更新，尚未作为新手机安装包交付；真实资源转写和完整 W09 验收继续进行。
