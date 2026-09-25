# iOS 系统能力与执行正确性深读审计输入

日期：2026-09-12。审计者：iOS 独立子任务。对象：`/Users/leoyuan/Documents/日常 2/LeoPhoneAgent`，基线 `094d4f8c`（主代理已核对等于 origin/main），iOS `1.34.0 (109)`。主机 `LeoyuandeMacBook-Pro-2.local`，Xcode `26.6 (17F113)`。本文件为主报告第 2 轮系统能力和第 3 轮正确性/恢复的输入；不冒充多次完整重审。没有修改产品代码、安装实机或发布。下列路径均相对上述源码根。

## 结论

iOS 已经有真实的 26 个 apple-* 能力家族，健康、日历、提醒事项、相册、定位、HomeKit、NFC、BLE、通讯录、文件、拍摄/扫描、动作识别、快捷指令均有原生 handler。`iSH/ISHKernel.m:416–449` 完成注册，`NativeOffloads/*Offload.m` 包含真实系统框架调用，不能把已有能力重新列为新建事项。

但“26 类已注册”离“系统能力完整、调得动、结果可信”仍有三层差距：手电筒等高频小能力缺失；调用入口依赖模型→shell→iSH，权限判断没有落在真实 native 边界；执行状态和结果回执不足以区分已启动、成功、失败、中断。优先补齐这三层，再扩展系统面和动效，用户会直接感受到更快、更稳定、更可控。

证据分层：下文“已实现”仅指源码执行链存在；未测的硬件、后台、生效情况均不计为已通过。对 Apple 平台支持边界由主报告结合官方文档确认，不用本文件取代当日官方验证。

## 1. 高置信审计发现

### IOS-01 · P1 · 产品自定义权限仅预检第一条命令，未覆盖实际原生调用

链路：`Agent/Chat/AIChatViewModel+ConcurrentTools.swift:261–278` 对整个 `shell_execute` 只调用一次 `extractOffloadCommand` / `checkPermission`。`Agent/Offload/OffloadPermissionPolicy.swift:15–25` 仅按空白分词，并在遇到第一个匹配时立即返回。`deps/ish/kernel/native_offload.c:647–648` 直接执行 handler，`821–824` 把识别到的 native entry 交给该路径；已查看的 contacts/camera/device 注册没有再查产品权限。

纯 Swift 复现实测（只分析字符串，没有执行任何设备读取）：

```
apple-device info && apple-contacts list => apple-device
'apple-contacts' list => nil
sh /tmp/read_contacts.sh => nil
cd /tmp && apple-camera status => apple-camera
```

触发：用户在产品内将通讯录禁用，但此前已给 iOS TCC 通讯录权限；模型或脚本使用复合命令，第一项为允许的 device；或执行脚本内部调用。产品“禁用”无法保证执行时禁止该项。系统 TCC 仍生效，这不是绕过 iOS 沙箱/系统授权。主 shell 的敏感工具闸门也仍存在，但它不替代逐项禁用。

最小正确改法：在统一 native handler dispatch 层加入带 session/task context 的授权回调，按“能力+动作”执行时检查；shell 文本分析仅用于预览。既要覆盖聊天工具，也覆盖 iSH terminal、脚本、NativeMCP、快捷入口。不要尝试靠增加正则修完 shell 语法。将应用权限和 TCC 两层状态明确展示。

测试：现有 `MinisTests/OffloadPermissionPolicyTests.swift:11–26` 只覆盖直写命令/路径/前置 cd，不测多 offload、引号、脚本、授权撤销、并发。新增真实 dispatch contract fixture 和无系统副作用的 mock handler；禁用能力在所有入口必须返回 denied，允许的独立能力不能误拦。

### IOS-02 · P1 · 快捷任务把处理停止直接记为成功

`Agent/Intents/QuickTaskIntent.swift:181–208` 等待 `isProcessing == false` 后无条件 `markCompleted`、通知 Done、返回 `status: "Completed"`；`217–235` 的异步路径同样仅观察停止状态。网络错误、内核不可用、用户取消都会使 VM 不再处理，不能据此认定成功。一般聊天结束路径已有更精细错误判断（`AIChatViewModel+BackgroundTask.swift:129–143`），快捷入口没有复用。

`Agent/Intents/QuickTaskWidgetRunner.swift:105–145` 最多观察 15 分钟，超时后依旧进入发布阶段；`157–164` 只检测最后一条 assistant 有非空 text，`134` 就设 succeeded。运行中的中间说明、随后失败但保留的解释文字都满足条件。保留 pending briefing 以便进程恢复是已经做对的，不能把它误报为没有持久恢复；问题是徽标与业务结果判定。

改法：统一 `runID + terminalOutcome + resultRevision`，快捷返回、通知、Widget、Live Activity 都读同一持久结果。`.succeeded/.failed/.cancelled/.suspended/.running/.waitingForUser` 分开。超过观察预算只停止观察或显示“仍在运行/结果待刷新”，不能制造成功/失败。沿用现有 AgentRunState/AgentActivityPhase，不另建互相矛盾的状态机。

测试：快速成功、启动失败、无文字成功产物、先文字后失败、用户取消、16 分钟仍运行、进程中断后回读、旧结果晚于新 run 抵达。现有 activity model 单测测试了终态属性/恢复，但没有覆盖这些 Intents→VM→Widget 调用链。

### IOS-03 · P1 · 后台“有效”判断使用设置开关，不使用真实执行状态

`Agent/Background/BackgroundKeepAliveManager.swift:125–127` 的 `enhancedBackgroundEffective` 等于两个偏好开关；真实音频引擎状态另有 `silentAudioIsPlaying`（292）。`1295–1315` 明确存在 engine.start 成功/失败及有限重试。因此用户两个开关都开着时，真实 engine 仍可能未启动、被中断或失败。

`Agent/Chat/AIChatViewModel+BackgroundTask.swift:20–26` 在 continued-processing 到期时依据配置“有效”直接不处理；`68–79` 在有限后台任务到期时重新申请并继续；`430–433` 也据配置跳过挂起。触发窗口：两个开关开启，音频引擎三次启动失败/通话中断，且 continued-processing 无有效授权；应用把配置当成活着的后台执行条件，可能失去及时 checkpoint/暂停机会。没有用真机强制注入该故障，所以这是源码确认的状态契约缺陷，不宣称已复现系统杀进程。

改法：把 configured、requested、active、interrupted、expired 分开；后台准入使用当前受系统支持的 execution grant、真实运行状态和生命周期。到期先保存安全检查点，再明确暂停或交给 Mac。保留用户已开启的偏好，避免因本次故障自动重写其设置。不要以重复申请有限后台时间承诺无限运行。

### IOS-04 · P2 · 取消/超时相机工具后没有收尾呈现中的相机

`NativeOffloads/NativeOffloadUtils.h:127–128` 将 semaphore wait 替换为可取消版本；`.m:30–45` 每 100ms 检查取消并返回 ECANCELED。**因此旧结论“camera 必须阻塞 300 秒才可取消”是错误的，本次已排除。**

真正问题：`NativeOffloads/CameraOffload.m:59–66` 对非零等待结果一律说 timeout，并直接返回；没有通知 Swift bridge dismiss / stopScanning / clear active delegates。`CameraOffloadBridge.swift:19–27` 用 static delegate 标记 busy，`49–55` 据此拒绝下次调用。调用已被取消但原相机 UI 尚存时，后续相机动作可能被 busy 拒绝；迟到捕获仍可能写文件。用户手动关闭旧 UI 才能走到正常清理。

改法：每次 capture 分配 operation ID；bridge 暴露幂等 cancel(id)，在 cancel/timeout/scene关闭走统一关闭与回调只一次；区分 cancelled、timed_out。验证关闭后重新调用可用、迟到回调不得误归入下一任务；photo / barcode / doc 全覆盖。

### IOS-05 · P2 · 原生快捷指令只有启动回执，没有完成回执

`NativeOffloads/ShortcutsOffload.m:138–167` 在 openURL 成功后返回 launched；`212–225` 的 success/error/cancel 都回到无 host 的 `leophoneagent://`，明确写着 results not returned。它的行为是诚实的“启动已登记 Shortcut”，不是通用 iOS 自动化执行闭环。当前 list 只列用户登记的名字，不是枚举系统快捷指令库（76–83）。

改法：增加 requestID、独立的 success/error/cancel callback 路由、一次性关联标记、持久 awaitingExternal 状态与超时；返回值通过具体受控 contract，敏感大数据通过已授权文件引用。原生启动回执必须维持 launched，收到对应回执后才能变 completed。对于不返回的 Shortcut 显示“已交给快捷指令，结果待确认”。不能据 URL 打开成功声称 Wi‑Fi、Notes 等动作已经生效。

### IOS-06 · P2 · 能力中心的可用性不够精确

`Agent/Offload/CapabilityAuthorizationProbe.swift:112` 把 alarm 固定为 unknown/首次使用询问，而 `NativeOffloads/AlarmOffloadBridge.swift:63–77` 已实际读取 `AlarmManager.authorizationState`。可以直接复用只读状态，不需要新增权限弹窗。

`OffloadPermissionManager.swift:274–277` 把 speech/media/player 归为“no personal data, always bypass”，但同文件 `231–237` 又承认这些工具读取数据并可进入模型对话；media search 会读媒体库，speech 会处理录音。它们不应因为历史归类而永远隐藏应用授权开关。

能力中心 `Views/Settings/CapabilitiesView.swift:23–27` 只搜 label/name/description；system 多数 description 为空（OffloadPermissionManager:279–286），用户搜中文动作（例如“音量”）不一定找到对应能力。卡片没有 action-level 支持范围、运行条件、最近实测结果。主代理额外核对SettingsHomeView.swift:109的“外观”搜索关键词含手电筒，但实际没有torch handler；搜索命中设置不代表功能可用，应从统一动作目录生成同义词。

改法：由统一 CapabilityDescriptor 生成目录、工具 schema、权限、中文同义词与自测；状态分开显示硬件/OS、系统授权、应用授权、前台条件、外部依赖、上次结果。不可查询读权限的 HealthKit 现有解释正确，应保留；不能改成虚假的全授权绿勾。

### IOS-07 · P2 · 扫码首次授权顺序阻断首次请求

`CameraOffloadBridge.swift:164–168` 先检查 `DataScannerViewController.isAvailable` 再 `ensureCameraAuth`。Apple 官方说明 isAvailable 的条件包含已获得相机许可和没有相机限制。主代理已读取当日官方 JSON 核验。因此首次未授权直接扫码会在 ensureCameraAuth 前被拒绝，用户只能先用拍照授权或去设置；这是代码与官方契约共同支持的判断，未在本子任务实机重现。改为硬件支持→用户相机授权→实时可用性，错误信息区分权限/Screen Time/摄像头占用。来源：[Apple isAvailable](https://developer.apple.com/documentation/visionkit/datascannerviewcontroller/isavailable)。

### IOS-08 · P1 · 用户选择“离线识别”后仍可静默降级到在线识别

上游调研子任务提示后，本子任务独立核对：`Providers/Voice/VoiceProvider+System.swift:119–126` 明确把不支持 on-device 的 Offline 语言降为 Online；`145` 将 requiresOnDeviceRecognition 设为 false。界面有独立的“System Recognition (Offline)”选项（`Views/Providers/UnifiedModelPicker.swift:24–37`、`Providers/Voice/SystemVoiceCatalog.swift:216`），`VoiceProviderResolver.swift:400` 明确把 Offline 解释为隐私/机上识别；`VoiceInputPanel.swift:661–669` 解析该选择并放入后续转录请求。因此这是产品隐私承诺与运行策略冲突，不只是注释表述。

触发：用户明确选择Offline，但当前语言/设备不支持本地识别；网络可用时系统请求不再强制机上。此处未抓取真实音频网络流量，不能报告“已证明某段录音外传”；但执行代码确实未守住用户选定的离线边界。

最小改法：将策略设为严格offline / explicit-online / automatic；严格offline不支持时返回 actionable unavailable，提示语言包/替代输入，不能自行联网。automatic是否允许联网遵循已展示的用户选择，并在结果携带实际执行位置。测试选项×支持状态×网络状态完整矩阵，证明strict offline永不构造允许服务端的请求。

## 2. 已有 iOS 能力账本与下一步

所有下列“已接入”均是源码层：共同注册见 `iSH/ISHKernel.m:416–449`，具体 handler 在 `NativeOffloads/`。这不是 26 个家族逐动作真机通过的证明。

| 能力 | 现有真实覆盖 | 正确边界与下版重点 |
|---|---|---|
| Device | info/battery/storage，型号、温度、内存、电量、磁盘 | 没有手电筒、屏幕亮度；设备信息默认回传中含 identifierForVendor，应按任务最小化输出 |
| Camera | 前后相机 photo、扫码、扫描多页文档、status | 明确前台用户拍摄；补生命周期取消、扫码首次授权、结果→OCR→藏宝阁链路 |
| Vision | OCR、条码、分类、目标/人脸、相似度/重叠 | 本地视觉提取后再决定是否送模型；把结果转结构化 artifact；不能描述为身份识别 |
| Photos | 列表/时间地点过滤/相册/统计/导出/导入/收藏/删除 | 删除有 --confirm + Photos framework；有限照片授权、iCloud 下载、原片/缩略图分别测试 |
| Contacts | list/search/get/groups/create/update/delete/status | 写入有 --confirm；补受限联系人、单项字段选择、同名歧义、预览→写→回读 |
| Calendar | events/reminders/freebusy/calendars/create/update/delete | 和 Reminders 是共享 EventKit 实现；补只写授权、时区/DST/重复事件范围、幂等创建 |
| Reminders | list/create/update/complete/delete | 已转入 Calendar handler，不是缺实现；补到期/地点条件和重复任务边界展示 |
| Alarm | AlarmKit set/timer/list/cancel | 已接入 iOS 26，且 labels SQLite 持久化；不是 Clock App 任意闹钟管理；补授权状态与真实响铃验证 |
| Notification | 本应用 pending/delivered/settings/schedule/cancel | 无法读其他 App 通知；下版统一 deep link、成功/失败通知语义、隐私模式 |
| Location | current/reverse geocode/forward geocode | 区分一次性定位与持续跟踪；精确/模糊定位，前后台授权，过期位置 |
| Maps | POI search、route、eta | 多数动作依赖网络；补出发/目的地来源、路线结果卡、用户确认打开导航 |
| Weather | current/hourly/daily/alerts/report | 已有 WeatherKit bridge；区分授权/网络/位置失败，展示更新时间与来源 |
| HealthKit | 查询广泛指标、batch、types、log、delete、特征/ECG/听力/视力/评估 | 深度已经很高；按类型最小授权、空数据≠拒绝、写入来源和幂等；不要把高敏数据全量送模型 |
| Motion | steps/activity/status，近 7 日 | 不是任意长期连续传感器工作流；补硬件可用性、时间段和省电采样 |
| HomeKit | homes/rooms/accessories/search/get/set/scenes/trigger | 控制支持的已配对家庭设备；不是任意 IoT；危险动作明确结果回读与逐动作授权 |
| BLE | status/scan/connect/disconnect/services/read/write/notify | BLE GATT，不是所有经典蓝牙设备，也不是切系统蓝牙开关；订阅取消/断连/恢复需硬件测试 |
| NFC | NDEF、raw tag、APDU、FeliCa、EMV inspect | 受硬件/标签/entitlement限制；支付数据只做用户明确授权任务且避免云端回传，绝非支付凭据通用控制 |
| Clipboard | get/set/clear/status | 前台粘贴系统交互仍有边界；不做全局剪贴板监听；给输入预览和来源 |
| Files | 授权目录/list/pick/reauth/remove | 用户 picker/security-scoped grant；不能读取任意 App 私有目录；补授权失效可恢复路径 |
| Shortcuts | 用户登记/list/run/open/unregister | 名字登记不是系统枚举；launch不是completion；最适合补间接系统/第三方能力 |
| Speak | 系统 voice/speak/stop | 已有 rate/pitch/voice等，不等于系统全局音量控制；与录音/通话争用测试 |
| Speech | transcribe/languages/status | 重视文件/麦克风来源和设备能力；作为隐私动作显示，不归“无个人数据” |
| Player | 原生文件播放/pause/resume/seek/stop/list/status | 应用自己持有的播放会话；视频/音频 session 打断需恢复 |
| Media | 媒体库 search/play-search、playback、volume | 音量通过临时零尺寸 MPVolumeView 子视图 slider (MediaOffload:253–284)，没设置成功标志；真实系统版本兼容需测，不视为可靠全局控制 |
| Open | URL/tel/sms/mailto/settings/maps 等 | 打开拨号/撰写不等于拨通/发送；App-Prefs 深链 (OpenOffload:46–63) 不是稳定公开系统控制契约 |
| NLP | language/tokenize/POS/NER/sentiment/embed/analyze | 本地处理已存在；可用于低延迟意图路由，避免手电筒等简单动作绕模型 |

## 3. “iOS 系统能力都能调动”的可交付表达

把需求兑现为“公开系统能力全面建账，允许的直接做，需用户操作的可靠接续，平台不开放的明确替代”，不能承诺任意跨 App 全权限。下列为下一版完整能力规划，具体 Apple API 可用性以主报告官方来源核验为准。

### P0 高频直接能力

1. 手电筒 `torch.status / set(on, level) / off`。原生 AVFoundation 服务，硬件hasTorch/available，序列化与相机资源互斥，热状态/被系统关闭后回读，支持幂等 set，避免 toggle 重试导致反转。iPad/模拟器无灯要返回 unavailable。语音和中文自然指令、工具 schema、能力中心、自测、AppIntent/Control Widget 共用同一服务。普通开关不用先启 iSH 或等待 LLM；低置信语句才进模型。亮度级别以设备支持能力为准，失败不假成功。
2. 屏幕亮度（有系统支持 API 的范围）、触感/震动反馈、设备低电/过热/存储告警。亮度需标明作用范围/持续规则；默认尊重用户动作与可恢复策略。
3. 可靠倒计时/闹钟/提醒、摄像头扫码、文档扫描→OCR→收藏、拍照→识别→结果、快速笔记、定位→路线。现有框架做闭环和快捷入口，不另造平行工具实现。
4. 通讯录→拨号、短信/邮件撰写、系统分享、打印、打开文件。这类动作始终区别 prepared/presented/userCompleted，不能用 URL 返回值当发送成功。

### P1 个人生产力与系统入口

- AppIntents / Siri / Spotlight / Shortcuts 已有会话、收藏、快速任务、设备等实体和入口；SessionSpotlightIndexer已索引会话，CollectionSearchIndex已索引收藏。深化同名歧义、授权、冷启动、锁屏的端到端测试，不列为新接入。
- Control Center已有NewChat/Voice/Camera三个ControlWidget（主代理核对AgentLiveActivityWidget.swift:1947–1985）。下一版保留，新增手电筒和明确高频动作入口，扩展锁屏 / Action Button / 快速收藏 / Mac审批；入口数量服从系统平台配额，不把所有能力同时塞进首页。
- Live Activities / Widget：只呈现已确定阶段与可行动状态；缺网络显示时间戳，审批有过期状态，进程不在不能显示仍实时更新。
- 图片/视频挑选与有限照片库、文件 provider、分享扩展、扫描、标记、PDF、UTType / QuickLook、拖放、跨设备剪贴板相关流程。
- EventKit 的日历/提醒深化、AlarmKit 场景、WeatherKit/MapKit 日常场景、MusicKit/媒体播放授权及限制。
- 听写/本地语音/系统文本识别已有基础；LocalBrain.swift已用Foundation Models做摘要/改写/结构化任务（主代理核对）。保留并深化本地意图路由和Translation等缺口，按设备、模型下载、语言能力登记；不是要求每一款iPhone全功能相同。

### P2 专项硬件、家庭与高级授权

- HomeKit/Matter 配对与既有家庭控制、BLE与NFC能力描述/连接管理、外设会话恢复。
- CoreMotion/位置/地理围栏/健康专项；提醒触发与持续后台必须有真实用途和授权，不借为无限 agent 保活保证。
- LocalAuthentication/passkeys/Keychain 的项目自身认证能力；不读取别的 App 密码、短信验证码数据库、通话记录或Apple Pay密钥。
- StoreKit/Wallet相关仅在产品有明确用途和对应 entitlement 时引入；不为了“全系统”增加无收益权限。
- ScreenTime/FamilyControls、NetworkExtension、CarPlay等依赖特定资格/entitlement/产品类别的能力列为条件能力，先核准资格再估工期。

### 间接能力与不开放能力

Notes、Focus、部分系统设置、第三方 App 动作优先用户自己的 Shortcuts/AppIntents contract。Wi‑Fi/蓝牙/蜂窝/飞行模式任意切换、任意其他 App UI 操纵、读取全部通知/聊天内容、任意进程后台永驻，不能规划成普通 iOS App 的直接公开能力；提供跳转/引导/Shortcut或Mac远端替代并准确展示执行地点。尤其 iOS 无法代替 Mac 全局 Accessibility 自动化；不能把 Mac 的可控性写成手机本地已支持。

### iOS 27 未来兼容轨

主代理当日官方研究确认 iOS 27 新增 ScreenCaptureKit 支持与 LongRunningIntent，需单列未来兼容轨，不能笼统写“iOS不支持屏幕捕获”。本次实际构建工具链为 Xcode 26.6 / iOS 26.5，未对27新API构建/设备执行。屏幕捕获和第三方App任意UI控制是不同能力；新增录屏不等于跨App自动点击授权。计划需按availability、用户授权、捕获范围/停止指示、后台生命周期分别验收；具体官方链接、SDK/设备验证由主报告补足。

## 4. 统一能力底座，避免新增动作继续复制缺陷

建立轻量 CapabilityDescriptor：id、action、input/output schema、native/shortcut/remote执行地点、minOS/hardware、systemAuthorization、appAuthorization、foreground/lock条件、risk、idempotency、timeout、cancel、undo/readback、result evidence。先把现有26家族逐动作登记；目录从它生成，避免手工维护帮助文本/权限表/工具schema/能力页面四处漂移。

执行路径：自然语言或按钮 → 本地确定性意图识别（只针对明确高频操作）→ 参数校验 → 能力条件探测 → 必要用户交互 → 原生执行 → 读回/回执 → 持久结果 → 同步更新聊天/Widget/动态岛/Mac。模糊或组合需求才进入模型规划。旧 apple-* CLI 为兼容 adapter，仍走同一 dispatch。

持久任务状态复用现有 AgentRunState，不重建整套调度。升级 ledger 增加 operationID/runID、写前意图记录、外部回执、terminal outcome、恢复策略。只读可安全重试；set可幂等重试；创建提醒/写健康/发送类不可盲目重放，必须先查operationID或等待用户决策。单个native UI操作有有界生命周期，切会话和取消后不留孤儿。

## 5. 和已有审计/实现对照，防止重复建设

- `docs/AUDIT_THREE_ROUNDS_2026-09-06.md:35–40` 已登记26类能力。此次不是再把它们统计一次，而是审真实动作、前台条件、权限和回执。
- 旧报告设置层级、能力中心、首页按钮可见性已有修复；本次三个静态门禁均通过，不能报告为仍有空动作。
- NativeOffloadUtils 已统一100ms协作取消；剩余是UI/外设收尾和cancel语义，不能计划“从零引入可取消等待”。
- `Shared/CollectionStore.swift:1471–1519` 已有 processing job 30分钟租约回收、最多5次重试。`QuickTaskWidgetRunner.swift:64–70,144–150` 已有持久pending briefing。不能宣称“项目所有后台任务都只有内存”。
- `AIChatViewModel.swift:2901–2955` resume 已保留committed文字/工具并接续，`MinisTests/InterruptedTailTests.swift`已有tail单测。下一步是副作用去重、统一run outcome和故障注入端到端恢复。
- 原生闹钟已经AlarmKit并持久化label，HomeKit、BLE、NFC、通讯录写入、HealthKit广泛类型都不是新功能空白。

## 6. UI / 动效落地建议（本子任务未做视觉评分）

能力中心按用户动作检索，例如“开灯/手电筒/照亮”“扫一扫”“十分钟后提醒”，结果直接说明“本机可做 / 需前台 / 需授权 / 交给快捷指令 / 此机不支持”。显示具体状态，不让用户理解 apple-* 命令名才能操作。首页只留少量高频行动和正在等待的事项，完整能力面进入目录。相机/权限/外部Shortcut是任务阶段，不是突然弹出的无来源系统窗。

动效围绕真实阶段：按下立即高亮+触感；执行中按钮变为可取消状态；系统回读成功后再落成成功图标；错误保持原上下文，给重试/授权/换设备动作。短操作不能为展示动画故意拖慢；长操作只更新必要区域，聊天流不因每个token重排整页。Reduce Motion显示静态阶段；VoiceOver读状态改变而非每帧动画；Dynamic Type、44pt触控、iPad键盘/分栏与深浅色跟随主代理视觉核查。

## 7. 最小充分验证与提升分数的可量化门槛

先运行当前门禁建立基线，再按变更补测试。分数应由通过率/延迟/失败恢复/可访问性证据换算；不能仅因计划漂亮承诺升级后95分。

| 验收面 | 必须覆盖 | 建议晋级门槛（目标，非实测） |
|---|---|---|
| 高频本机动作 | torch/on/off/level、计时器、扫码、快速笔记 | 支持设备上100次重复，成功率≥99%；warm命令→可见反馈p95≤150ms；动作完成按API不同单列 |
| 权限 | 首次/拒绝/受限/撤销/复合命令/脚本/并发 | 产品禁用100%在真实dispatch拦截；不误触额外能力授权 |
| 生命周期 | 用户取消、前后台、锁屏、切任务、来电、系统资源占用 | 无孤儿相机/录音/NFC/BLE订阅；取消反馈p95≤250ms（系统UI关闭时延另计） |
| 正确状态 | 成功、失败、取消、暂停、长任务、迟到结果 | 聊天/Shortcut/Widget/LiveActivity一致，无假成功；旧run回执不能覆盖新run |
| 副作用恢复 | 写前/写后/回执前强制结束进程 | 创建提醒/闹钟等同一operation不重复；不确定则明确提示，不自动重做 |
| 流畅度 | 1k/10k消息、长工具输出、键盘、100条收藏、低电/热态 | 实测掉帧/hitch、内存峰值和输入延迟；按60/120Hz分别验收，不拿静态grep证明丝滑 |
| 设备矩阵 | iPhone有torch、iPad无torch、26.x主版本、支持的旧硬件 | 每个硬件差异清晰降级；sim仅跑逻辑不能替代硬件 |
| 藏宝阁 | 分享→扫描/OCR→索引→Mac同步、离线重连、正文/附件按需 | 原始资料不丢、去重和冲突可解释、失败可重试，保留现有tombstone/lease能力 |

## 8. 验证证据

- `./scripts/IOSReleaseReadinessAudit.sh`：exit **0**，`1.34.0 (109), release prompt, and product identifiers passed`。
- `./scripts/IOSAccessibilityMotionAudit.sh`：exit **0**，centralized haptics and repeating-motion gates passed。仅能证明命名/源码模式，不证明所有动效视觉和性能。
- `./scripts/IOSVisibleControlAudit.sh`：exit **0**，no no-op controls；40 empty actions are alert dismissal buttons。没有执行每个按钮，不宣称交互全通过。
- `swift /tmp/leophone-permission-audit.swift`：exit **0**，源码纯函数复现IOS-01，输出见上；未运行任何隐私读取。
- `xcodebuild test -project LeoPhoneAgent.xcodeproj -scheme MinisLogicTests -onlyUsePackageVersionsFromResolvedFile -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' -derivedDataPath /tmp/leophone-ios-audit-20260912 -only-testing:MinisTests CODE_SIGNING_ALLOWED=NO`：exit **0**，日志有 **TEST SUCCEEDED**。
- `xcrun xcresulttool get test-results summary --path /tmp/leophone-ios-audit-20260912/Logs/Test/Test-MinisLogicTests-2026.09.12_12-04-03-+0800.xcresult --format json`：exit **0**，**337 passed / 0 failed / 0 skipped**，iPhone 17 Pro iOS 26.5 Simulator；测试时长约34.05秒（不含依赖准备和构建）。只跑逻辑测试，不构建完整iSH/Watch产品，不等于发布门禁。日志 `/tmp/leophone-ios-audit-20260912.log`，独立 derived data `/tmp/leophone-ios-audit-20260912`。
- 未做：真机安装、真实torch/蓝牙/NFC/健康/闹钟、弱网/通话/杀进程、UI帧率、耗电。主报告如有其他执行证据须独立注明来源。


### 证据文件与复核导航

- 完整逻辑测试日志：`ios-logic-tests.log`（已从本次独立derivedData执行复制）。
- xcresult结构化汇总：`ios-logic-test-summary.json`。
- 权限解析器纯函数复现：`ios-permission-parser-repro.swift`（来自本基线源文件+仅打印结果的输入；无设备操作）。
- 完整模拟器App追加构建：`ios-full-simulator-build.log`；exit **65 / BUILD FAILED**，完整结论见下，不使用已有旧App替代。


## 9. 追加有界验证：完整模拟器App构建失败

主代理追加授权后，使用同一094d4f8c基线、独立derivedData、Debug、未签名尝试完整LeoPhoneAgent scheme：

```sh
xcodebuild build -project LeoPhoneAgent.xcodeproj -scheme LeoPhoneAgent -configuration Debug -onlyUsePackageVersionsFromResolvedFile -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' -derivedDataPath /tmp/leophone-ios-full-audit-20260912 CODE_SIGNING_ALLOWED=NO
```

原命令退出码 **65**，日志 **BUILD FAILED**。首个真实阻断在 `ios-full-simulator-build.log:31761`：

```text
ld: building for 'iOS-simulator', but linking in object file (.../deps/libs/libish_emu.a[2](emu_tlb.c.o)) built for 'iOS'
```

即当前预编译iSH archive是设备平台对象，完整模拟器链接不能使用它。存在生成中的.app目录不代表构建成功，也不能安装作当前基线UI验证。没有为绕过失败修改产品目标/依赖，没有换旧包。`ios-full-simulator-build-summary.json`保留结构化摘要。

对升级计划的影响：要把可靠模拟器全App视觉/回归纳入持续门禁，需预先建立device与simulator分离的native依赖产物（或XCFramework）和可复现构建步骤；测试逻辑target337通过只证明逻辑面，不能遮住完整App构建差异。此项是构建可验证性前置任务，不据此推断当前iPhone安装包不能运行。
