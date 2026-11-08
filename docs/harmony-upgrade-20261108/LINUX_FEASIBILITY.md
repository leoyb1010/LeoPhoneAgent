# HarmonyOS 本机 Linux 兼容运行时实证

2026-11-08，Mac Studio，DevEco Studio 26.0.0 配套 Harmony NDK。

## 判断

现有 ARM64 iSH 的解释器、系统调用模拟、文件、网络和 PTY 主体具备可移植的源码基础。本次使用实际 Harmony NDK 编译真实源文件，80 个以上编译步骤中的绝大多数通过，全部 ARM64 gadget 汇编也能编译。继续推进本地 iSH 移植有实证依据。

后续实施已完成真实 iSH/SQLite/N-API 动态库链接、Alpine 安装包生成，以及官方鸿蒙模拟器中的本地客体运行。App 沙箱内 N-API 与目标 HarmonyOS 7 真机验收仍需最终交付证据。本报告只给出编译层证据与明确缺口。libuv 负责宿主事件循环，Linux 系统调用和 ARM64 指令语义仍由 iSH 提供。

## 探针边界

- 未修改 `deps/ish` 源码。
- 探针、源副本、命令 argv、编译日志与 ELF 对象全部在 `/Users/leoyuan/Dev/leobot-harmony-upgrade-20261108/linux-probe/`。
- 只进行交叉编译与链接。本次没有运行客体程序，没有使用容器、虚拟机或远端执行。
- 第一次编译缺少 SQLite 声明。后续探针将本机 Xcode SDK 的 `sqlite3.h` 复制到探针目录，仅用纯 C API 声明验证 iSH 源码兼容性。没有把 Apple 动态库交叉链接到 HarmonyOS。

## 已执行的证据

### Harmony NDK 宿主能力

`ndk_contract.c` 使用公开的 `mmap(PROT_READ|PROT_WRITE)`、socket、openpty 和 libuv。

实际执行 NDK clang，目标 `aarch64-linux-ohos`，带配套 sysroot，`-fPIC -shared -luv`，链接退出码 0。`libndk_contract.so` 经 file 确认为 ARM aarch64 ELF shared object。这证明工具链提供相应接口和链接符号，App 沙箱运行权限仍须实际验证。

### iSH 编译

`probe.py` 保存 23 个独立编译的 argv、退出码和日志。补入 SQLite 声明后，20 个单元通过，包括 ARM64 解码生成器、解释器调度、密码指令辅助、任务与 ELF 执行、内存映射、futex、信号、文件系统、网络和 PTY。

`full_probe.py` 从当前 meson 文件提取主运行时源文件，另编译 fakefs、native offload 及全部 ARM64 gadget 汇编。共 83 个步骤，79 个通过。偏移生成使用仓库真实 `tools/staticdefine.h`，生成 71 个定义，随后全部 gadget 汇编通过。

后续 `vdso_probe.py` 使用现有 guest ARM64 VDSO 源码、真实链接脚本和 freestanding clang 参数生成 `libvdso.so.elf`，并重新编译 `kernel/vdso.c` 嵌入该 ELF。两步退出码均为 0，VDSO 构建缺口已在探针中闭环。

此处统计包含偏移生成和一个显式可移植性副本探针，并非 79 个独立功能验收。全部结果见 `full-results.json`。

## 初次探针发现的编译缺口

| 位置 | 实际错误 | 处理路线 |
|---|---|---|
| `kernel/fork.c:23` | `_Atomic(function_pointer) = NULL`，OHOS musl 的 NULL 为 void 指针，静态初始化不是编译期常量 | 显式转换为对应函数指针零值。仅在探针副本验证，编译通过 |
| `kernel/calls.c:53` | 同类原子函数指针初始化 | 对 timer hook 使用相同显式类型处理 |
| `fs/fake.c:116–117` | 同类路径转换 hook 初始化 | 对两个 hook 使用显式函数指针类型 |
| `fs/fake.c:789–838` | 使用 Apple 专属 `stat.st_*timespec` | 非 Apple 分支使用 POSIX `st_atim/st_mtim/st_ctim`，保留纳秒精度 |
| `fs/fake.c:1154,1230` | `F_GETPATH` 不存在 | 显式维护已打开句柄的应用沙箱路径，或验证 `/proc/self/fd` 的平台可用性后采用受约束 readlink。路径仍须经过 mount/root 边界校验 |
| `kernel/vdso.c` | 初次缺少 `libvdso.so.elf`，incbin 失败 | 已在探针中用原源与链接脚本生成 ELF，并成功重新编译嵌入；实际 App 构建需接上同一步骤 |
| fakefs 链接 | 配套 NDK 缺少公开 SQLite C 头及同名链接库 | 按现有 fakefs 的 SQLite 语义编译固定版本 SQLite 源码，或验证可复用的项目已有编译产物。仅声明头不足以完成运行时 |

原始日志已保留，不将缺口通过空实现或删去运行语义处理。

## 实现路线

1. 为 Harmony NDK 添加独立构建描述，明确宿主 OHOS / guest ARM64，生成偏移与 guest VDSO，编译可移植平台层和 SQLite。
2. 在保留 Linux guest 语义的前提下修复上述 ABI 与路径差异。Apple-only 原生卸载优化需保持清晰的平台边界。
3. 将运行时封装为 App 内 N-API 模块，异步工作线程承载解释器，提供独立会话、stdin/stdout、取消、退出状态和错误。
4. 使用用户态 Linux rootfs，保留 UID/权限/链接、fakefs 元数据及升级迁移规则。所有宿主文件路径限制在授权挂载和 App 私有目录中。
5. 将 shell 工具、终端与现有会话审批接入同一个本地执行器，分别验证 PTY、文件读写、管道、子进程模拟、DNS/TLS 和进程退出清理。
6. 用真实 HarmonyOS 7 App 依次执行 shell、BusyBox、Python 与 Node 客体程序。每项保留命令、退出码、输出和原生崩溃日志，再测长任务、后台暂停与恢复。

## 运行与维护未知

- 编译通过尚不能证明 App 沙箱允许全部宿主调用，尤其信号恢复、PTY、线程属性、文件锁和大地址空间。
- guest rootfs、动态加载、DNS/TLS 信任链、网络权限和文件系统权限仍需集成。
- 当前 ASM 核心使用预编译 gadget 与数据调度，不能据此直接声称全部依赖没有可执行内存要求，必须审计所有内存映射和第三方客体执行路径。
- 现有 iOS 性能数据不能作为鸿蒙性能证据。三折叠、Pura X Max 的吞吐、内存、温升、耗电及系统后台行为均待真机测量。
- ARM64 gadget 分发、宿主 ABI 适配和 Linux syscall 模拟需要随 iSH 上游与 Harmony NDK 更新维护。

## 当前验收状态

源码与交叉编译可行性有积极证据。完整 App 内本地 Linux、PTY/文件/联网端到端运行仍待完成，保留为当前完整交付目标中的未完成项。


## 实施后的原生实证

### 固定来源与构建

- SQLite 3.50.4 官方源码包 `https://www.sqlite.org/2025/sqlite-amalgamation-3500400.zip`，SHA256 `1d3049dd0f830a025a53105fc79fd2ab9431aea99e137809d064d8ee8356b032`。
- Alpine 3.22.2 aarch64 minirootfs，官方地址在 `prepare_linux.py` 中固定，SHA256 `6bf491907b705caa5fc65773fbbc1d0954530b6c455d4446f670a4c1fdcea489`，已与官方同名 `.sha256` 对照。
- 仓库真实 `tools/fakefs_import` 通过 Mac 原生构建预处理镜像，生成真实 fakefs 元数据与文件。App 内采用有路径、单项大小与总量边界的私有安装 pack。初始 pack 为 8,625,046 字节，SHA256 `75086c7364317a501ac354744a8e7bc07f6db5e3a494cbf8ecafb9b8311f59b9`。
- App 原生库实际交叉编译 SQLite 源码。完整动态库采用 `--no-undefined` 链接成功，并提供 N-API 初始化、创建客体任务、PTY 输入输出、窗口尺寸、退出码和停止操作。
- App 使用真实 guest PTY 驱动，宿主 CLI 专用 `tty-real.c` 不进入 App 构建。该文件需要的 `pthread_cancel` 没有被空实现替代。
- ELF 链接揭示原仓库 `bits.S` 和 `math.S` 的四个重复 gadget。overlay 保留与 `gen.c` 内联操作数格式匹配的 `math.S` 实现，并使用 `-Bsymbolic` 绑定解释器内部短跳转。
- 许可证以 iSH 仓库实际 GPLv3 与附加条款为准。准备脚本生成随包许可证文本与 Alpine 包级许可证、版本、源项目及提交信息。

### 官方模拟器中的实际执行

设备目标为官方 HarmonyOS 6.1.1 aarch64 模拟器 `127.0.0.1:5555`。下列设备 probe 与 App 链接同一 `linux_core.c`，这一层尚不证明 App 沙箱或 HarmonyOS 7 真机。

| 实际检查 | 结果与日志 |
|---|---|
| guest `/bin/sh` 执行 echo、uname、文件写读与授权工作区挂载 | PASS，`emulator-core.log` |
| guest PTY 交互输入、输出与退出码 | PASS，`LEO_PTY_INPUT`、exit 7，`emulator-pty.log` |
| guest 原生 socket 读取宿主测试 HTTP 服务 | PASS，`LEO_LINUX_NETWORK_OK`、exit 0，`emulator-network.log` |
| guest DNS 解析官方 Alpine 域名 | PASS，`emulator-dns.log`；生产 App 从当前 NetworkKit 网络读取 DNS |
| 停止 guest 死循环 | PASS，stop 返回 0、exit 137，`emulator-cancel.log` |
| guest 主动 SIGSEGV | PASS，guest exit 139，宿主 probe 存活，`emulator-guest-signal.log` |
| 根 shell 退出后的后台子进程输出 | PASS，后台输出完整后 exit 0，`emulator-background-child.log` |
| 安装包路径穿越、超长路径、超量大小、内容截断 | 全部拒绝，外部 sentinel 不变，`emulator-install-boundaries.log` |
| 截断安装后同目标目录重试真实资源 | PASS，`INTERRUPTED_INSTALL_RECOVERED`、exit 0 |

### 真实路径逃逸反例与修复

旧绑定路径实现会跟随工作区内的宿主物理 symlink。原生 probe 确实读取到工作区外的专用 sentinel，失败证据 `emulator-boundaries-native.log` 保留。

已在最小构建 overlay 中统一修复宿主路径入口。路径逐级通过目录 fd 与 `O_DIRECTORY | O_NOFOLLOW` 解析，最终打开同样使用 `O_NOFOLLOW`。stat 保留物理 symlink 类型，文件创建、删除、重命名、硬链接、目录创建、权限及时间修改都经过相同边界。

同一反例在修复后通过，相对 symlink、绝对 symlink、`..`、宿主绝对路径和 guest proc/fd 均未读出 sentinel，向绝对 symlink 写入被拒绝，宿主 sentinel 保持原值。证据 `emulator-boundaries-fixed.log`。

### 所有者与异步取消

`LinuxRuntime` 只从真实 App context 生成 rootfs、pack 与 workspace 路径。模型工具输入仅提供 guest 命令，不提供宿主路径。PID 绑定 owner，跨 owner poll/write/stop 被拒绝。初始化 await 后、创建任务前及运行期间均检查取消回调。输入最多 4096 字节，输出环形缓冲最多 1 MiB，收集结果与 UI 显示另有上限。

`protocol/linux-runtime.test.mjs` 加载真实 ETS，通过平台适配器验证 owner 隔离、输入边界、固定 App 路径、启动前取消和启动后停止。该层不代替原生设备证据。

### 待补的完整验收

- App 沙箱内真实 N-API 初始化与终端、Agent 工具入口。
- 目标 HarmonyOS 7 的 Mate XT2 / Pura X Max 真机覆盖升级、性能、后台与生命周期。
- iOS 特定预置工具与系统权限仍按总功能清单验收。基础语言工具已纳入下述离线包。


## Node、离线工具与独立 stdio 收口

### Node 启动阻塞的实证修复

Node 22.23.4 的 `--version` 初次通过，但执行 JavaScript 时出现启动等待。实际 syscall 日志显示，每个 worker 申请约 128 MiB 栈，第四次 mprotect 返回 ENOMEM，随后线程停留在初始化屏障。对应 PSS 约 42 MiB，线程为 sleeping/poll 状态。

原因是 iSH 的 128 MiB 默认软栈限制与本 App 的 512 MiB guest 提交预算组合。新 App Linux 会话使用 8 MiB 默认软栈限制，硬限制仍保留可调，总 guest 内存预算保持 512 MiB。修复后默认 `node -e` 真实输出成功并 exit 0，单轮约 0.926 秒。显式 jitless/single-threaded 组合也 exit 0，约 1.796 秒。相关日志 `emulator-node-{version,default-fixed,jitless-fixed,systrace}.log`。

OHOS 平台适配器同时修正 kB→byte、CPU 字段顺序和 uptime tick 单位，并在系统计数暂不可读时返回可恢复结果。

### 随包离线工具

`prepare_linux_packages.py` 与 `cpp/linux-packages.json` 固定 54 个官方 APK 的 URL、版本和 SHA256。App 内真实 guest apk 依据 Alpine 原有信任钥匙验证签名，离线安装 Node、npm/npx、Python、pip、bash、git、curl 及依赖。

当前 `linux-packages.pack` 为 56,174,548 字节，SHA256 `226d2a56c65ecc5f59aa22f8bd5971a2a2e4a33d52ff184152d988e5acff7ace`。包挂载到固定 App 私有目录并以只读 `/mnt/bootstrap` 暴露。安装脚本只选择缺失或更旧版本，成功验证全部包与真实工具调用后，ArkTS 才原子提交 profile marker。

新 root 首次完整离线安装实测约 29.34 秒，包含 npm/npx/pip 的实际调用。更高版本策略反例将隔离测试 APK DB 中的 Node 版本置为 99.0.0-r0 后重新执行，确认该版本元数据、实际 Node 二进制、root 用户文件与工作区文件哈希均保留。该用例模拟已升级包的版本元数据，实际执行的二进制仍为已验证的 Node 22。日志 `emulator-bootstrap-full-preserve-newer.log`。

### 工作区管理回归

首版安全 overlay 曾将原生 mount 占位清理也路由到 guest bind，隔离 probe 工作区的测试文件因此被清空。已将原生 mount 管理操作与 guest 文件操作分离，并拒绝自动清理已有非 symlink 用户目录。

修复后，同一非空工作区经历三个独立进程重启、rootfs 截断安装失败、同目录恢复安装，文件内容及 SHA256 均保留。每一步均通过 HDC 单独收回到 Mac 复核。相关哈希 `33d0ef1240103dd4b8d1699bab7a311dae93a45a1428a1aa57de316142b98e23`，日志 `emulator-workspace-preservation.log`。本次失效只发生于隔离测试区，真机未安装该中间版本。

### 独立 stdin/stdout/stderr

`startStdio` 使用真实宿主 pipe 与 guest fd table，TTY `start` 保持原接口。stdout 有界缓冲满后采用 pipe 背压，stderr 独立有界诊断缓冲，两个流分别消费和完成 EOF。所有者、取消、根进程与孤儿回收沿用同一运行时。

system_integration 独立 guest probe 已通过 BusyBox 与 Node 两套长驻 MCP 服务。覆盖初始化、6 KiB 长行、逆序响应、多回合 counter、取消后继续、进程组退出 137、stdin 秘密配置无回显，以及 stderr 中合法伪 JSON-RPC 不进入 stdout/RPC parser。日志 `mcp-guest-native-pipes-probe.log` 与 `mcp-guest-node-native-pipes.log`。

`linux-runtime.test.mjs` 加载实际 ETS，验证 owner 隔离、固定 App 路径、stdio 字段分离、输入边界、初始化取消，以及安装失败/marker 存储失败不提交 ready、显式重试恢复。平台适配器测试与原生 probe 分层记录。

### OS7 执行代际与挂载反例复测

当前项目专属 `127.0.0.1:15566` 的系统版本为 OpenHarmony 7.0.0.105。使用独立物化的 Release SDK 26.0.0.105 编译 shared NAPI 与同源 device probe，构建日志为 `air-safety-build.log`。整包 HAP 和 ArkWeb/App 沙箱旅程由父任务另行绑定产物验收。

每次执行分配不可变的 generation，fork 与 clone 继承。创建准入在 pids_lock 内复核，进程与线程共用单执行 64、全运行时 256 的明确配额。计数保留至对应 pid 回收且宿主线程完成最后清理，取消按 generation 扫描全部后代，脱离进程组或重新托管不会解除 owner。最后退出线程使用 thread-group leader 与 generation 匹配原执行。

`air-scope-os7.log` 真实覆盖关闭三流的后台后代、setsid 后代、根退出后取消、进程及线程配额，连续八轮每轮均恢复 slots=0/tasks=0。四个并发执行达到 256，第 257 个启动返回 EAGAIN，取消后仍为 0/0。后台延迟写入标记均不存在，日志终态为 `SCOPE_ALL_TASKS_RECLAIMED` 和 `PROBE_STATUS=0`。

活跃 bind 的本体及祖先禁止 guest 移动或替换。原生 mount 管理保留原始宿主调用，继续只刷新运行时拥有的 symlink。安装 marker 命中仅跳过 APK 安装，每个 App 进程仍恢复 bootstrap 的只读 bind。

`air-bind-restart-preservation.log` 在同一个非空工作区、三个新的宿主进程中，分别验证 `/mnt` 移动和替换被拒、bind 本体移动被拒、宿主 symlink 读取与写入被拒、bootstrap 写入返回 EROFS。普通 workspace 内文件 rename 仍成功。工作区原有 persist、外部 sentinel、bootstrap install.sh 的宿主 SHA256 前后逐轮一致，终态为 `AIR_BIND_RESTART_PRESERVATION_OK`。

扩展反例发现旧 guest 的 `mount -t real` 可将宿主目录暴露给 guest，已用独立临时 sentinel 只读复现并记录 `air-real-mount-before.log`。当前 guest sys_mount 仅允许 proc/devpts/tmpfs 虚拟文件系统，宿主路径后端只能通过原生初始化使用。同一 OS7 反例现返回拒绝，无法访问 sentinel。未改动系统代理、生产文件或真机用户数据。

实际 ETS 回归 `linux-runtime.test.mjs` 同时证明持久 marker 存在时仍调用 native preparePackages 恢复挂载，但不重复执行安装脚本。该分层证明覆盖 ArkTS 控制逻辑与同源 native guest，当前 HAP 重启沙箱回归仍由父任务执行。

### PID 复用与延迟清理

执行 generation 之外，每个 task 另有不可变 identity。pthread cleanup 保留 generation、identity 和原 PID，避免长执行 PID 绕回时把新 task 误认为旧非 leader 的延迟清理对象。

device-only probe 调用同一生产 task allocator 与清理 hook，经过 32,766 次真实 task 分配使同执行的 PID 复用，再注入旧 identity 的延迟清理。该内核边界 fixture 明确验证新 task 没有被标记 finished、旧计数正常扣除、最终计数归还。它与前面的真实 guest 后代、setsid、Python fork/thread 和全局配额回归一同通过，日志为 `SCOPE_PID_REUSE ... result=0`。fixture 的旧 cleanup 通过受控注入，记录验证实际 task allocator 与同源清理函数的 PID 复用分支。
