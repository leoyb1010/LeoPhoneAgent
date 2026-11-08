# 原生生命周期定点修复

## 对应审查项

本轮聚焦 air-native-fix-review.md 的第 3 项 A、B、C，以及 MCP 超限关闭的原生回收联动。挂载、bootstrap、SSH 的已认可结果沿用父任务记录。

### A 可取消的阻塞 I/O

fast read/write 和 slow realfs read/write 使用同一 linux_io.c 路径。宿主 pipe 使用非阻塞描述符，guest 的阻塞与非阻塞语义由 fd flags 和有界 poll 等待实现。每次等待最多 50 毫秒，读者竞争或信号先于等待发生时也能重新检查。F_GETFL 隐藏内部强制的宿主非阻塞位，F_SETFL 保留用户选择。fast-path EINTR 同样进入 SA_RESTART 处理。stop 在排入 guest SIGKILL 后关闭宿主持有的 stdin 写端。

设备记录 air-io-cancel-probe-os7.log 覆盖 stdin 与内部 pipe 的 1/8192 字节 read、4096/8192 字节写满、fcntl 阻塞切换、两个线程竞争同一管道。十例全部 exit 137，slots/tasks 均为 0。最终同源构建记录的取消耗时为 5 至 95 毫秒。

### B 原子发布和失败回滚

创建准入、task_start 的取消检查／pthread 创建／有效 handle 发布，以及 stop 标记与扫描，共用 pids_lock。新 host worker 在该锁上等待发布完成。未启动的 scoped PID 保持构建期私有，失败的 never-started zombie 可正常等待回收。

完整 copy_task 的失败路径撤销 group_links 与独立 group 的 session／pgroup／TTY 引用，释放 mm、files、fs、sighand。group 建立后出现用户地址错误也走相同的组撤销。mm 与 group 分配失败向上返回错误。

air-lifecycle-probe-os7.log 通过 device-only 调度 hook，分别让进程与线程在 start 检查前取消、有效 pthread 已创建但 started 尚未发布时取消，以及注入 pthread_create EAGAIN。共六例完成回收。四例失败回滚逐项显示 mm/files/fs/sighand/threads 基线和结果均为 1。调度与错误注入仅编入 device probe，APP_PROBE_HOOKS_ABSENT 通过产品 shared library 符号检查。

### C 超时 worker 自身清理

safety-valve 将超时 task 标记 retired 并计入 group，保留其资源与组记录，直到 worker 真正返回宿主 syscall。worker 自身的 pthread cleanup 释放 fd table、fs、futex pipe、deferred mm、sighand 和信号队列，并重新托管子进程。非 leader 在该清理阶段销毁，leader 保留 zombie 回执供 waitpid。group 在 retired 计数归零前保持存活，scope 在清理和等待回收后归零。

同一设备日志通过受控阻塞真实触发 exit_group 的 safety-valve，分别覆盖晚结束的非 leader 与 leader。释放前 slots=1、tasks=2 或 1，释放后两个场景 slots/tasks 都为 0，deferred mm 在 refcount=1 时完成释放。受控调度用于稳定进入该分支，实际执行生产清理函数和原生等待回收。

## 兼容回归

相同 Release 构建继续通过关闭三流的后代、setsid 后代、八轮取消回收、64/256 配额和完整 PID 绕回的 identity 检查。另有原生 PTY 输入退出 7、并行任务仅目标 exit 137／另一任务 exit 0，以及真实 Node 22.23.4 文件读写并退出 0。

## 产物和后续联动

源代码保留在 canonical cpp 与 prepare_linux.py，额外 overlay 位于 scripts/linux_lifecycle_overlay.py，deps/ish 原位保持。产品 shared 与 device probe 来自同一 generated 核心，device-only hooks 由单独编译定义控制。

system_integration 正在独立 HAP stage 中执行生产 McpStdio／LinuxRuntime 与同一 NAPI 实例的超限压力回归，stage 仅增加只读 scopeCounts。该跨层结果由对应日志绑定，父任务继续执行实际 HAP 与最终定点验收。

## 实际 App 沙箱补测

HAP 域中 symlinkat 被系统拒绝，原始 App 记录 errno=13，初始化因而失败。当前采用纯虚拟 bind 和空实体目录占位，guest 访问统一经过现有路径翻译与 fd-relative safety shim。初始化仅 unlink 旧固定 alias，保留既有目录，非空占位目录返回迁移错误。原生 mount 管理保持独立于 guest shim，目录内容不被递归清理。

同一非空工作区的 CLI 迁移、普通文件读写、guest 虚拟软链接、相对路径和 proc fd 路径均通过。额外 placeholder fixture 在 rootfs 占位目录放入自有文件后，初始化拒绝且原文件与工作区哈希保留，移除该自有 fixture 后显式重试通过。三进程 readonly／ancestor／外部 sentinel 反例再次通过。

独立真实 HAP 在项目 OS7 15567 上执行生产 McpStdio、生产 LinuxRuntime 与同一 NAPI 实例。stage 仅增加只读计数及观测点。最终非空 golden 轮的报告为 mcp-pressure-native-golden.json。

- App 初始化复用原有 root 和 workspace。guest 的 ln/readlink、相对读写、cd/getcwd/proc fd 通过。
- npm --offline --ignore-scripts 安装本地 file 依赖并运行 node_modules/.bin，输出 APP_NPM_BIN_OK，自有临时目录清理完成。
- 单服务 128 帧超限时，原生峰值 slots=1/tasks=4，native write 返回 0 共 209 次，129 毫秒后 slots/tasks 为 0。
- 全局 256 帧超限时，原生峰值 slots=3/tasks=3，write 返回 0 共 489 次，115 毫秒后两项为 0。
- 自有普通 golden 文件使 workspace 聚合 SHA 非空，前后一致为 8fdfaa7a29db2d751fdba8c412d09a49b944a8ee1ecacdb4aeea7f2f683fadb2。

另一个有效 handle 反例对逻辑 init 发送 SIGKILL，旧 ELF 实际 abort 134。signal.c 现在只向有效 host pthread 发送唤醒，修复后同一 guest 命令输出并 exit 0，相关记录为 air-logical-init-signal-before.log 与 air-logical-init-signal-after.log。
