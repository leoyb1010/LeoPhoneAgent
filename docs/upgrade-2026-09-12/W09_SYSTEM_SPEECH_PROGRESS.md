# W09 系统语音实施进展

## 已实现的 iOS 源码

- 接入 iOS 26 SpeechAnalyzer / SpeechTranscriber，以 AssetInventory 检查设备、匹配语言及资源状态。已安装资源优先本机转写；识别请求不会自行下载资源。
- 旧 SFSpeechRecognizer 按严格离线／允许联网／自动政策选择。离线不支持时不切换联网；取消、超时和迟到回调经过统一请求生命周期处理。部分转写携带 isFinal=false。
- 识别结果携带引擎、执行位置、语言及最终性，语音面板、模型快速测试和调试回执均显示或保留相关信息。
- Providers 增加“系统语音与语言资源”入口，支持查询语言资源、主动下载、进度、请求取消、刷新及释放本 App 的语言保留。下载取消和等待超时不伪称资源已删除，以 Apple 状态回读为准。
- 自动模式默认不允许联网回退；用户可在资源页明确开启。模型列表说明同步更新。

## 证据与边界

- 392 项 MinisLogicTests 全部通过；最终 generic iOS 设备目标构建通过。
- 用实际资源页与实际资源接口搭建独立模拟器测试应用；仅 VoiceInputResponse 数据结构以同形值类型补足，不包含 iSH。iPhone 深色、iPad 竖屏和 iPad 宽窗口已截图检查，无文案截断。宽窗口是 iPadOS 窗口几何变化，不冒充设备物理横屏验收。
- 模拟器真实返回资源不支持，界面据此禁用下载。没有把模拟器状态伪造成已安装资源。
- 当前 Mac 的只读原生探测：SpeechTranscriber 可用，zh-CN → zh_CN、en-US → en_US，资源状态均为 supported（尚未安装）；探测未下载资源。
- 编译发现的两份同内容 iCloud 测试冲突副本已移至项目 outputs 中备份，保留原路径与 SHA-256 清单；未删除未知文档或其他冲突副本。

仍需完成：iPhone 真机资源下载与实际转写、录音通话/耳机中断组合、耗时与能耗对比、Mac 产品语音适配及原生命令路径进一步统一。W09 保持进行中。本轮源码尚未作为新 iOS 安装版交付，不覆盖此前 iPhone 1.35.0 (110) 的安装声明。

日志及截图：`outputs/implementation-2026-09-12/ios-system-speech/`。

## 接口依据

实现以本机 Xcode iPhoneOS 26.5 SDK 的 Speech.swiftinterface 为编译依据，并对应 [Apple SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer) 与 [AssetInventory](https://developer.apple.com/documentation/speech/assetinventory) 接口。框架的支持状态、资源状态与真正的转写运行证据分别记录，不互相替代。
