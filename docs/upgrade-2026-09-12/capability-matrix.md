# iOS 与 Mac 系统能力覆盖矩阵

共 80 项需求级能力。基线 094d4f8c，资料核验于2026-09-12。这里的“已有”表示源码调用链存在，不代表本次硬件验收完成。此表覆盖本产品相关系统能力家族与受限边界，不冒充 Apple 所有 API 的穷举；操作系统新增 API 与设备资格要继续通过 descriptor 自动建账。

路由分为原生直接、前台/系统UI、用户配置的间接集成、专项资格、明确不支持。优先级P0/P1进入下一版本主线；P2为可选增强或后续专项；27轨必须在支持的新SDK与目标设备验证后启用。

iOS原生现状主证据见 ios-audit.md 的26家族账本；Mac现状见 mac-audit.md。Apple链接证明平台API及边界，不证明本项目已经实现。

## 设备与即时动作

| ID / 能力 | 当前 iOS / Mac | 路由与限制 | 下一步 / 优先级 |
|---|---|---|---|
| C01 手电筒开/关/状态 | iOS：缺失；Camera/Device无torch；Mac：无对应闪光灯；应选iPhone目标 | 原生直接。hasTorch+isTorchAvailable+配置锁；不可把无硬件当成功。[Apple](https://developer.apple.com/documentation/avfoundation/avcapturedevice/hastorch) | 独立原生服务，中文直达、幂等set、状态回读。**P0** |
| C02 手电筒亮度 | iOS：缺失；Mac：经已授权iPhone执行 | 原生直接。浮点范围及当时最大亮度；热限制和相机争用。[Apple](https://developer.apple.com/documentation/avfoundation/avcapturedevice/settorchmodeon(level:)) | level夹紧、错误归因、实际level收据；无频闪默认。**P1** |
| C03 屏幕亮度 | iOS：Device无此动作；Mac：需单独核实显示器公开接口 | 原生直接。iOS主屏0到1，锁定设备后系统恢复原亮度。[Apple](https://developer.apple.com/documentation/uikit/uiscreen/brightness) | set/status及锁屏恢复说明；不改自动亮度设置。**P1** |
| C04 电量/存储/温度/设备状态 | iOS：Device已有info/battery/storage；Mac：已有部分宿主状态 | 原生只读。能力最小输出；不默认发送设备持久标识。[Apple](https://developer.apple.com/documentation/uikit/uidevice) | 动作级查询及低电/热状态调度。**P1** |
| C05 应用使用时保持亮屏 | iOS：已有KeepScreenAwakeController；Mac：需按任务核实电源声明 | 应用生命周期。仅真实任务与用户选择；不能等同禁止系统睡眠永不中断。[Apple](https://developer.apple.com/documentation/uikit/uiapplication/isidletimerdisabled) | 受控超时、结束恢复、明确执行位置。**P1** |
| C06 触觉/震动 | iOS：LeoHaptics已有反馈，非通用Agent动作；Mac：能力依设备；不模拟手机硬件 | 原生直接。硬件支持、减少动态/触觉偏好；不可持续滥用。[Apple](https://developer.apple.com/documentation/corehaptics) | 动作回执触觉一致，按需开放短反馈。**P1** |
| C07 媒体音量 | iOS：Media有零尺寸MPVolumeView slider方案，可靠性待测；Mac：可选公开系统/应用音量适配 | 系统UI优先。官方MPVolumeView面向用户交互；不能承诺铃声全局修改。[Apple](https://developer.apple.com/documentation/mediaplayer/mpvolumeview) | 显示原生音量控件、回读；不可靠自动set准确降级。**P1** |
| C08 AirPlay/音频输出设备 | iOS：播放器已有；统一输出选择未闭环；Mac：Electron录音需设备选择与变化监听 | 系统UI。由用户选择路由，不能静默劫持设备。[Apple](https://developer.apple.com/documentation/avkit/avroutepickerview) | 统一音频路由面板和耳机/通话中断恢复。**P1** |
| C09 Wi-Fi/蓝牙/蜂窝/飞行模式开关 | iOS：Open有App-Prefs不稳定深链；Mac：Mac各能力独立授权核实 | 受限/用户接续。iOS没有普通App任意系统开关权限；专用网络API不是总开关。[Apple](https://developer.apple.com/documentation/technotes/tn3111-ios-wifi-api-overview) | 提供公开设置入口/用户已配置Shortcut，返回handedOff。**边界** |
| C10 静音/低电量/自动亮度系统开关 | iOS：未有可靠公开通用动作；Mac：分设备API核实 | 受限/用户接续。不能把读取状态或私有深链当作修改权限。[Apple](https://support.apple.com/guide/security/security-of-runtime-process-sec15bfe098e/web) | 能力目录明确不支持项和手动/Shortcut替代。**边界** |
## 捕获与感知

| ID / 能力 | 当前 iOS / Mac | 路由与限制 | 下一步 / 优先级 |
|---|---|---|---|
| C11 拍照前后摄像头 | iOS：Camera photo已有；Mac：浏览器/原生相机授权待完整验证 | 前台交互。首次许可、可见拍摄、相机占用和取消。[Apple](https://developer.apple.com/documentation/avfoundation) | operationID统一取消，照片保存/识别/收藏闭环。**P1** |
| C12 扫码/二维码 | iOS：已有；首次isAvailable检查顺序有缺陷；Mac：可由摄像头或导入图识别 | 前台交互。先硬件→授权→可用；Screen Time与占用分别解释。[Apple](https://developer.apple.com/documentation/visionkit/datascannerviewcontroller/isavailable) | 首次扫码可请求授权、危险URL仅预览。**P0** |
| C13 多页文档扫描 | iOS：Camera scan-document已有；Mac：导入/扫描源适配待补 | 前台交互。系统扫描界面、取消、页面方向和尺寸。[Apple](https://developer.apple.com/documentation/visionkit/vndocumentcameraviewcontroller) | 扫描→OCR→可检索PDF→藏宝阁；原页保留。**P1** |
| C14 OCR/条码/图像理解 | iOS：Vision offload已有；Mac：藏宝阁图片当前partial，OCR engine未接 | 原生直接。大图降采样、语言/旋转、原始图不丢。[Apple](https://developer.apple.com/documentation/vision) | Mac用Vision补原生OCR；统一文字与区域artifact。**P1** |
| C15 选择与读取照片 | iOS：Photos已有；Mac：按用户选文件/Photos授权路径 | 系统授权。有限照片集、iCloud原片按需；不是所有相册默认可读。[Apple](https://developer.apple.com/documentation/photosui/photospicker) | 授权范围及缺原片状态，批量预算和取消。**P1** |
| C16 保存/收藏/删除照片 | iOS：Photos已有confirm写路径；Mac：导出与原生保存需适配 | 授权写入。用户选定范围、删除前预览；系统确认仍保留。[Apple](https://developer.apple.com/documentation/photos) | 写前摘要→写→资产ID回读；批量部分失败结果。**P1** |
| C17 视频/音频转码与压缩 | iOS：已有FFmpeg原生offload；Mac：已有文件/CLI基础 | 本地媒体任务。格式、空间、能耗、断点与取消。[Apple](https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados) | 共享artifact格式契约，独立后台任务与真实进度。**P1** |
| C18 麦克风录音 | iOS：已有语音输入/VAD；Mac：getUserMedia/MediaRecorder已有 | 前台启动。麦克风权限、来电/耳机切换、音频session。[Apple](https://developer.apple.com/documentation/speech/speechanalyzer) | 录音/转写/整理分段，取消全部资源，不留孤儿会话。**P1** |
| C19 系统离线语音转写 | iOS：SFSpeechRecognizer已有；Offline会静默放开服务端；Mac：现有语音输入需本地引擎 | 原生/可选模型。严格离线不得自动转在线；语言、设备、模型可用性。[Apple](https://developer.apple.com/documentation/speech/speechanalyzer) | 修Offline策略，优先SpeechAnalyzer；旧接口显式降级。**P0** |
| C20 可选中文离线ASR | iOS：未引入WhisperKit/whisper.cpp正式引擎；Mac：同左 | 可选下载。模型许可、大小、温度、静音幻觉。[Apple](https://developer.apple.com/documentation/speech/speechtranscriber) | 相同语料A/B，二选一，按需下载可删除。**P2** |
| C21 朗读/TTS | iOS：Speak与系统/第三方TTS已有；Mac：已有语音能力但统一生命周期待补 | 原生或显式云端。与录音互斥；声音选择和用户隐私偏好。[Apple](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer) | 同一播放状态、暂停/继续、耳机断开与来电恢复。**P1** |
| C22 音视频播放/进度/倍速 | iOS：Player已有pause/seek等；Mac：浏览器媒体+文件基础 | 应用会话。操作自有播放或公开媒体接口；不等于控制所有App。[Apple](https://developer.apple.com/documentation/mediaplayer) | 统一播放器与Now Playing/控制中心适配。**P1** |
| C23 媒体库搜索/播放 | iOS：Media已有；Mac：依用户媒体授权/供应商 | 系统授权。媒体库许可/订阅/地区，分开本地和流媒体。[Apple](https://developer.apple.com/documentation/mediaplayer) | 能力条目真实状态与播放结果，不走免授权标签。**P1** |
| C24 屏幕录制/共享内容 | iOS：26线未形成统一录屏工具；Mac：exact-window不是屏幕采集实现 | 用户启动系统UI。26线评估ReplayKit；Mac用公开ScreenCaptureKit；敏感画面用户选范围。[Apple](https://developer.apple.com/documentation/replaykit) | 先Mac内容选择器+受控采集；iOS26独立研究验证。**P1/P2** |
| C25 iOS27 ScreenCaptureKit | iOS：当前SDK26.6不能验收该新API；Mac：Mac12.3起公开框架可独立使用 | 版本隔离。Apple当日文档iOS/iPadOS introducedAt=27.0；新SDK+运行时双门禁。[Apple](https://developer.apple.com/documentation/screencapturekit) | 下一SDK影子构建与能力协商；不提高当前26线承诺。**27轨** |
| C26 任意其他iPhone App自动点击 | iOS：无通用公开能力；Mac：Mac AX是另一平台边界 | 受限。录屏/看见不等于注入点击；AppIntents不是任意系统控制。[Apple](https://support.apple.com/guide/security/security-of-runtime-process-sec15bfe098e/web) | 优先公开API/Shortcut/第三方集成，无法做则交接用户。**边界** |
## 个人事务

| ID / 能力 | 当前 iOS / Mac | 路由与限制 | 下一步 / 优先级 |
|---|---|---|---|
| C27 日历查询/创建/更新 | iOS：Calendar已实现；Mac：建议窄原生EventKit适配 | 系统授权。只写/全读、重复事件范围、时区DST。[Apple](https://developer.apple.com/documentation/eventkit) | 预览范围→幂等写→ID回读；与已有handler共享。**P1** |
| C28 提醒事项/完成/删除 | iOS：Reminders复用Calendar已有；Mac：可增EventKit适配 | 系统授权。同名清单/重复项/到期语义、不可盲目重试。[Apple](https://developer.apple.com/documentation/eventkit) | 离线自然语言高频直达、重复提交不重复创建。**P1** |
| C29 系统级闹钟/计时器 | iOS：AlarmKit已有set/timer/list/cancel；Mac：无原生macOS同等AlarmKit承诺 | 系统授权。管理本App创建的闹钟；不是Clock中所有闹钟。[Apple](https://developer.apple.com/documentation/alarmkit) | 复用authorizationState，真实响铃/取消/重启验证。**P1** |
| C30 通讯录查询/变更 | iOS：Contacts已有；Mac：可增Contacts原生适配 | 系统授权。受限联系人、字段最小化、同名歧义。[Apple](https://developer.apple.com/documentation/contacts) | read和write分别授权；新增联系人前预览并回读。**P1** |
| C31 拨号/FaceTime交接 | iOS：Open tel等已有；Mac：公开URL/Continuity交接 | 系统UI。打开界面≠拨通；用户完成通话操作。[Apple](https://support.apple.com/guide/security/security-of-runtime-process-sec15bfe098e/web) | prepared/presented状态与目标确认。**P1** |
| C32 短信/邮件撰写 | iOS：Open sms/mailto已有；Mac：系统分享/URL或服务API | 系统UI。用户点发送；Mail outbox排队不保证送达。[Apple](https://developer.apple.com/documentation/messageui) | 用MessageUI预填/附件/取消回调，回执不夸大。**P1** |
| C33 读取短信/邮件收件箱/通话记录 | iOS：无普通iOS通用数据库访问；Mac：只做用户授权服务集成或受控Mac路径 | 受限。MessageUI不是收件箱API；不能借MCP或iSH越权。[Apple](https://support.apple.com/guide/security/security-of-runtime-process-sec15bfe098e/web) | 列清不支持；按账户连接器另行授权和显示来源。**边界** |
| C34 运行已登记Shortcut | iOS：已有list/run/open，只有launched回执；Mac：可用shortcuts CLI/原生接续 | 用户配置间接。不能枚举任意系统私有捷径；外部调用可能不回调。[Apple](https://developer.apple.com/documentation/appintents) | requestID+一次性回执、awaitingExternal、取消/超时。**P1** |
| C35 第三方App能力/Notes任务 | iOS：以已配置URL/Shortcut/MCP集成为主；Mac：同上，另可公开Apple Events | 声明集成。第三方必须暴露能力且用户授权；无通用Notes数据库权限。[Apple](https://developer.apple.com/documentation/appintents) | 登记可验证连接器，参数预览和结果receipt。**P2** |
## 文件与知识

| ID / 能力 | 当前 iOS / Mac | 路由与限制 | 下一步 / 优先级 |
|---|---|---|---|
| C36 系统分享/接收图片链接文件 | iOS：ShareExtension已接；原始字节保存；Mac：拖放/上传已有，原生分享建议补 | 系统UI。来源不可信；写入原件成功后再增强。[Apple](https://developer.apple.com/documentation/uniformtypeidentifiers) | 统一快速收集回执、来源与离线队列。**P1** |
| C37 选文件/外部文件夹授权 | iOS：Files/安全作用域/挂载已有；Mac：文件与终端强，但需作用域能力目录 | 系统UI+授权路径。书签失效、外部盘断开、跨启动读写权。[Apple](https://developer.apple.com/documentation/fileprovider) | 失效重授权不丢引用，逐任务目录范围。**P1** |
| C38 Files App File Provider | iOS：已有Target；Mac：可选Finder扩展不做默认依赖 | 系统扩展。同步/占位/冲突/离线，用户文件是原始资料。[Apple](https://developer.apple.com/documentation/fileprovider) | 回归当前provider，不另复制一套同步库。**P1** |
| C39 Quick Look/文件格式预览 | iOS：已有artifact/WebApp/文件预览基础；Mac：代码/HTML/文件视图已有 | 原生/受控预览。MIME+字节+来源校验；HTML不得获得工具权限。[Apple](https://developer.apple.com/documentation/quicklook) | 统一Preview/Open/Export/Save receipt。**P1** |
| C40 PDF提取/高亮/标注 | iOS：藏宝阁正文高亮已接；Mac：PDFKit JXA提取+高亮已有 | 原生本地。页码/文本偏移、扫描PDF无文字需OCR；原PDF不丢。[Apple](https://developer.apple.com/documentation/pdfkit) | 阅读模式优先、原页高亮映射和导出。**P1** |
| C41 打印与系统导出 | iOS：未作为统一Agent动作建账；Mac：系统打印/分享候选 | 系统UI。用户选择打印机/份数；不能把打开对话框当打印完毕。[Apple](https://developer.apple.com/documentation/uikit/uiprintinteractioncontroller) | 生成可打印artifact并系统呈现，记录presented。**P2** |
| C42 拖放/多窗口/iPad键盘 | iOS：已有布局与部分拖放；Mac：桌面拖文件已有 | UI与作用域。跨App拖入内容不可信；焦点与未保存编辑保留。[Apple](https://developer.apple.com/documentation/uniformtypeidentifiers) | iPad窄宽双态、键盘、文件拖入统一验收。**P1** |
| C43 iCloud/收藏增量同步 | iOS：CloudKit/SQLite/tombstone/游标已有；Mac：手机镜像+本地收藏已有 | 授权同步。正文/附件按需，作用域和冲突不混；离线不冒充实时。[Apple](https://developer.apple.com/documentation/cloudkit) | 补崩溃/断线/大库游标与可解释冲突。**P1** |
| C44 HTML/图片/报告artifact | iOS：本地生成/预览/分享基础已有；Mac：已有文件、浏览器与artifact管线 | 本机或Mac协作。生成≠渲染≠导出成功；HTML脚本和外联受控。[Apple](https://developer.apple.com/documentation/uniformtypeidentifiers) | 类型注册、真实预览、失败原因、保存回执和跨端交接。**P1** |
| C45 备份/恢复大库 | iOS：已有备份；缺上游流式writer/journal；Mac：需统一备份与升级恢复演练 | 本地持久任务。空间预算、格式版本、部分恢复、凭据单独选择。[Apple](https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados) | 吸收OpenMinis流式ZIP与恢复journal，验证失败可回退。**P1** |
## 空间与环境

| ID / 能力 | 当前 iOS / Mac | 路由与限制 | 下一步 / 优先级 |
|---|---|---|---|
| C46 一次定位/逆地理 | iOS：Location已有；Mac：按Mac定位授权可补 | 系统授权。精确/模糊、过期、无GPS、网络失败。[Apple](https://developer.apple.com/documentation/corelocation) | 显示精度/时间/来源；避免无限定位保活。**P1** |
| C47 地理围栏/位置触发 | iOS：已有自动化基础，专项端到端未验；Mac：Mac不承诺手机等效触发 | 专项后台。系统配额/授权/调度；不是任意时刻必达。[Apple](https://developer.apple.com/documentation/corelocation) | 只做用户明确规则，延迟/未触发可诊断。**P2** |
| C48 地图/路线/ETA/打开导航 | iOS：Maps已有；Mac：可开原生地图或Web地图 | 系统/网络。路线模式与出发地确认，查询与导航交接分开。[Apple](https://developer.apple.com/documentation/mapkit) | 可交互路线卡、更新时刻、离线错误准确。**P1** |
| C49 天气/预警 | iOS：WeatherKit已有；Mac：可共享后端或独立授权 | 服务授权。资格/网络/位置；显示来源和时效。[Apple](https://developer.apple.com/documentation/weatherkit) | 场景卡只在有价值时出现，不常驻轮询。**P1** |
| C50 运动/步数/活动识别 | iOS：Motion已有近7日；Mac：Mac仅支持自身硬件可用子集 | 系统授权。不能从步数接口承诺所有传感器全天候采样。[Apple](https://developer.apple.com/documentation/coremotion) | 能力按设备声明，时间范围和能耗预算。**P2** |
## 健康与家庭

| ID / 能力 | 当前 iOS / Mac | 路由与限制 | 下一步 / 优先级 |
|---|---|---|---|
| C51 HealthKit读取/写入 | iOS：已有广泛类型工具；Mac：普通Mac部署不能承诺同等HealthKit | 按类型授权。空结果不代表拒绝；写记录来源/幂等；健康信息不默认上云。[Apple](https://developer.apple.com/documentation/healthkit) | 只读摘要优先，写入预览与撤销范围明确。**P1** |
| C52 HomeKit设备/场景 | iOS：HomeKit已有set/scenes/trigger；Mac：Mac支持取决于宿主技术/授权 | 家庭授权。只能操作已配对支持设备；门锁等逐动作确认。[Apple](https://developer.apple.com/documentation/homekit) | 场景卡、目标校验、读回状态，断网明确未完成。**P1** |
## 硬件与近场

| ID / 能力 | 当前 iOS / Mac | 路由与限制 | 下一步 / 优先级 |
|---|---|---|---|
| C53 BLE GATT扫描/读写/通知 | iOS：Bluetooth已有；Mac：可加CoreBluetooth适配 | 系统授权。不是经典蓝牙万能接口；不切系统总开关。[Apple](https://developer.apple.com/documentation/corebluetooth) | 设备会话、订阅取消、断连恢复和用户设备范围。**P2** |
| C54 NFC标签/NDEF/APDU | iOS：NFC已有较深实现；Mac：常规Mac无同等内置NFC | 前台+硬件资格。设备/标签/entitlement限制；不承诺支付密钥或门禁复制。[Apple](https://developer.apple.com/documentation/corenfc) | 危险写入和敏感读取单独授权；timeout取消会话。**P2** |
| C55 AccessorySetupKit配对 | iOS：未统一接入；Mac：不同macOS路径另核 | 系统配对UI。只对本App支持外设授权，不是扫描所有设备权限。[Apple](https://developer.apple.com/documentation/accessorysetupkit) | 有实际外设需求时替换分散配对流程。**P2** |
| C56 UWB附近距离 | iOS：未发现通用动作；Mac：硬件和平台按文档另核 | 硬件+会话。双方支持协议/硬件，非持续追踪任何人设备。[Apple](https://developer.apple.com/documentation/nearbyinteraction) | 设备能力探针+专项PoC，不作为下版必达。**P2** |
| C57 Wi-Fi Aware直连 | iOS：未接；Mac：硬件/平台分别协商 | 专项网络API。iOS26起、支持硬件；不是Wi-Fi总开关。[Apple](https://developer.apple.com/documentation/wifiaware) | 可作局域设备发现实验，不替换现有relay主链。**P2** |
| C58 AR/LiDAR/房间扫描 | iOS：未作为Agent能力集成；Mac：Mac主要消费产物 | 硬件+前台。依LiDAR/摄像头/空间权限；需要明确用途。[Apple](https://developer.apple.com/documentation/roomplan) | 扫描→结构化artifact专项插件，不默认常驻。**P2** |
## 端侧智能

| ID / 能力 | 当前 iOS / Mac | 路由与限制 | 下一步 / 优先级 |
|---|---|---|---|
| C59 本地翻译 | iOS：LocalBrain可做文本译写；无独立Translation服务；Mac：可用系统框架的窄helper | 模型/语言条件。系统语言包与模型资格；不能保证所有语言。[Apple](https://developer.apple.com/documentation/translation) | Translation系统包优先，明确本地/云端及下载状态。**P2** |
| C60 Foundation Models摘要/改写/任务草稿 | iOS：LocalBrain已经接入；Mac：可加现有Provider适配 | 模型可用性。设备资格/开关/模型准备/语言，失败不假成功。[Apple](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability-swift.property) | 补原因与超时/取消，扩大已有能力而非重复接入。**P1** |
| C61 独立MLX本地小模型 | iOS：未正式引入；Mac：候选Apple Silicon辅助模型 | 可选下载。模型许可/内存/热预算；不承诺云端推理等价。[Apple](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel/availability-swift.property) | 限摘要分类草稿，基准达标才启用。**P2** |
## 系统入口

| ID / 能力 | 当前 iOS / Mac | 路由与限制 | 下一步 / 优先级 |
|---|---|---|---|
| C62 Siri/AppIntents/任务实体 | iOS：已有多个Intents与QuickTask；Mac：Mac需要与实际任务路由统一 | 系统授权入口。暴露本App能力，不是调用任意其他App。[Apple](https://developer.apple.com/documentation/appintents/appintent/supportedmodes) | 共享terminalOutcome，冷启动/锁屏/同名歧义测试。**P1** |
| C63 Spotlight会话与收藏 | iOS：SessionSpotlightIndexer和CollectionSearchIndex已有；Mac：可选Mac原生索引桥 | 可搜索实体。尊重隐私开关，不索引敏感正文/query参数。[Apple](https://developer.apple.com/documentation/corespotlight) | 增量索引与删除、点击准确定位，保留隐私边界。**P1** |
| C64 控制中心/锁屏/Action Button | iOS：新对话/语音/相机三个Control已有；Mac：Mac不照搬手机ControlWidget | 系统入口。入口不等于后台无限执行；硬件动作与前台模式协商。[Apple](https://developer.apple.com/documentation/widgetkit/appintentcontrolconfiguration) | 加常用动作配置，复用同一服务，优先torch/收集。**P1** |
| C65 Widget任务与产物 | iOS：已有多种Widget；Mac：Mac候选原生Widget非必需 | 低频系统快照。刷新时机由系统控制；不能伪装秒级实时。[Apple](https://developer.apple.com/documentation/widgetkit) | 同一run结果、来源时间戳、隐私和点击恢复。**P1** |
| C66 Live Activities/灵动岛 | iOS：已有ActivityKit状态；Mac：Mac菜单栏/任务状态用原布局 | 系统状态面。进度必须真实；长任务可取消；终态和推送一致。[Apple](https://developer.apple.com/documentation/activitykit) | 失败/等待用户/暂停明确，多端审批只一次。**P1** |
| C67 Focus Filter | iOS：未发现SetFocusFilterIntent；Mac：可按平台支持另接 | 本App筛选。过滤本App内容/上下文，不能直接控制系统专注模式。[Apple](https://developer.apple.com/documentation/appintents/setfocusfilterintent) | 工作/私人项目与通知筛选，默认不开启自动切模型。**P2** |
| C68 本地通知/通知操作 | iOS：Notification与任务通知已有；Mac：桌面通知已有 | 用户授权。只能管理本App通知；发送≠用户已读。[Apple](https://developer.apple.com/documentation/usernotifications) | 统一通知内容/隐私/去重/点击/过期审批。**P1** |
## 系统生命周期

| ID / 能力 | 当前 iOS / Mac | 路由与限制 | 下一步 / 优先级 |
|---|---|---|---|
| C69 26持续后台处理 | iOS：BGContinuedProcessing已有；Mac：Mac任务服务另有生命周期 | 系统可撤销执行。前台用户启动；可被资源压力/用户取消终止。[Apple](https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados) | 有效grant判断、检查点、过期暂停/交接Mac。**P0** |
| C70 大文件后台上传下载 | iOS：按需下载与Range已有；独立后台URLSession深化；Mac：Mac继续后台任务服务 | 系统传输。适合文件传输，不等于LLM websocket长连接永久存活。[Apple](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/background(withidentifier:)) | 可恢复background session、回调与临时文件一致性。**P1** |
| C71 iOS27长AppIntent任务 | iOS：当前26SDK不能编译验收；Mac：macOS文档27新增契约另核 | 版本隔离。LongRunningIntent introduced27，持续报告真实进度与取消。[Apple](https://developer.apple.com/documentation/appintents/longrunningintent) | 影子SDK构建，不取代26已实现的Continued Processing。**27轨** |
## 身份与受限能力

| ID / 能力 | 当前 iOS / Mac | 路由与限制 | 下一步 / 优先级 |
|---|---|---|---|
| C72 FaceID/TouchID/App锁 | iOS：LocalAuthentication与会话锁已有；Mac：可用Mac本机验证 | 用户认证。生物识别失败/锁定/后台；不是额外系统访问权。[Apple](https://developer.apple.com/documentation/localauthentication) | 高风险动作可按策略再验证；不把解锁等同全权。**P1** |
| C73 Passkeys/登录与Keychain | iOS：项目认证已有，passkey专项未建账；Mac：safeStorage/本机token已有 | 本App身份。不能读取其他App密码/验证码；凭据不进模型。[Apple](https://developer.apple.com/documentation/authenticationservices) | 逐服务凭据域与授权状态，连接器可撤销。**P2** |
| C74 Wallet/支付/票证 | iOS：未作为通用能力；Mac：需具体商户/票证资格 | 资格+用户交互。PassKit权限与发行资格；不是任意读取/支付控制。[Apple](https://developer.apple.com/documentation/passkit) | 列目录与明确支持范围，专项需求才实现。**边界** |
| C75 Screen Time/应用限制 | iOS：未接FamilyControls；Mac：macOS路径不同 | 专项资格。FamilyControls/ManagedSettings授权用途和资格，不是万能App管理。[Apple](https://developer.apple.com/documentation/familycontrols) | 先资格/设备PoC，默认不承诺控制任意App。**P2** |
| C76 VPN/网络扩展/过滤 | iOS：未作为通用系统动作；Mac：Mac网络扩展另行资格与安装 | 专项资格。NetworkExtension需对应entitlement/用户同意。[Apple](https://developer.apple.com/documentation/networkextension) | 作为可选专项；不让Agent直接改当前网络配置。**边界** |
| C77 商店安装/卸载/系统更新 | iOS：普通App无任意静默管理权；Mac：Mac可经用户授权安装流程 | 受限/明确安装任务。分发/管理资格另核；iSH不是iOS宿主root。[Apple](https://support.apple.com/guide/security/security-of-runtime-process-sec15bfe098e/web) | 准确交接用户或受管设备方案；本版不造越权承诺。**边界** |
| C78 其他App私有文件/通知/安全芯片 | iOS：无公开通用权限；Mac：Mac也受TCC/文件权限/硬件限制 | 不支持。沙箱与系统保护；屏幕可见不等于能读取私有数据库。[Apple](https://support.apple.com/guide/security/security-of-runtime-process-sec15bfe098e/web) | 明确unsupported与公开集成替代，不反复试私有接口。**边界** |
## Mac原生协作

| ID / 能力 | 当前 iOS / Mac | 路由与限制 | 下一步 / 优先级 |
|---|---|---|---|
| C79 真实窗口观察/操作/回读 | iOS：手机作为已授权控制面；Mac：当前exact-window只有内存状态 | Mac公开AX+ScreenCaptureKit。目标窗口稳定身份、TCC、前台/背景差异、截图时效。[Apple](https://developer.apple.com/documentation/applicationservices/axuielement) | 窄Swift helper，真实observe/act/receipt，未实现不报success。**P0/P1** |
| C80 本机服务/登录项/更新后恢复 | iOS：消费Mac可用性，不控制其系统策略；Mac：已有Electron服务和更新链 | Mac原生服务。签名身份/登录项授权/升级回退/TCC连续性。[Apple](https://developer.apple.com/documentation/servicemanagement/smappservice) | SMAppService候选与现有helper二选一，签名包验收。**P1** |
