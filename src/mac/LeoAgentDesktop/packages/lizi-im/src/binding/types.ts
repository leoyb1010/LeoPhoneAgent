/**
 * @cindy/im/binding/types.ts
 * ---------------------------------------------------------------------------
 * Channel-agnostic identity binding abstraction.
 *
 * 用途: 多 IM 渠道下让"用户身份 → 任意 host 实体"的映射有一个统一类型。
 *   - feishu bot 接管 desktop session: TValue = desktop sessionId
 *   - 未来 slack/discord 等 channel 共用同一抽象, host 端注入不同 store 实现
 *
 * 这层只定义类型与接口, 不提供实现 — host (apps/desktop) 必须自己提供
 * BindingStore 的具体实现 (典型: SQLite / electron-store / 内存)。
 *
 * 设计取舍:
 *   - 同步 get(): 路由层 (如 runAgentTurn 入口) 每条消息查一次, 走异步会拖累
 *     turn 启动延迟。约定 host 实现需在启动时 await preload() 把全量数据预热
 *     到内存 Map, 之后 get() 直接 O(1) 读
 *   - 异步 attach/detach: 写操作要持久化到 SQLite/disk, 异步合理
 *   - findByTarget: 反向查找 (TValue → IdentityKey) — 给 desktop "收回" 按钮
 *     用 (renderer 只知道 sessionId 不知道 identity, 必须反查)
 *   - onChange: 事件订阅 — host 用它把 binding 变更广播给 renderer 渲染 mask /
 *     收回按钮等 UI 状态
 */

/**
 * 用户身份的复合主键。
 *
 * - channel: IM 渠道名, 如 'feishu' / 'slack' / 'discord'
 * - botContextId: 该 channel 下区分"哪个 bot 实例"的 id (feishu: app_id;
 *                 slack: workspace + bot user; 等)
 * - userId: 该 channel 下的用户唯一标识 (feishu: open_id; slack: user_id; 等)
 * - scopeKey: 可选的会话维度键 — thread 能力渠道(slack)用 thread root ts
 *             区分同一用户的多条并行接管(每 thread 一个 binding);无 thread
 *             概念的渠道(feishu)不填, 语义上等价于 ''。
 *
 * (channel, botContextId, userId, scopeKey ?? '') 组合后唯一标识一条对话身份。
 */
export interface IdentityKey {
  channel: string;
  botContextId: string;
  userId: string;
  scopeKey?: string;
}

export interface BindingChangeEvent<TValue> {
  identity: IdentityKey;
  /** null = detach (该 identity 的 binding 已删除); 非 null = attach 或 update */
  value: TValue | null;
  /**
   * 前一个 value (该 identity 在事件触发前 attach 着的值);
   * null = 之前没 attach 过 (新 attach) 或重复 detach (no-op)。
   *
   * 给 listener 区分"attach / detach / 同 identity 切换 target"用 — detach 类
   * 清理逻辑 (比如 feishu 取消 fanout listener) 没有 prevValue 就拿不到该清理
   * 哪个 sessionId 的 in-process state, 没法跟 channel-agnostic 的 binding 层
   * 解耦 (否则 binding 层得反向 import channel 实现)。
   */
  prevValue: TValue | null;
}

export type BindingChangeListener<TValue> = (
  event: BindingChangeEvent<TValue>,
) => void;

export interface BindingStore<TValue> {
  /**
   * 启动时一次性把持久化数据加载到内存。host 必须在 app boot 流程中 await 一次,
   * 此后 get() 才会有正确数据。重复调用幂等。
   */
  preload(): Promise<void>;

  /** 同步读取 — 必须在 preload() 之后调用; 未命中返回 null。 */
  get(identity: IdentityKey): TValue | null;

  /**
   * 反向查找: 给定 value, 返回当前 attach 着这个 value 的 identity。
   * 找不到返回 null。多个 identity 都 attach 同一 value 时返回任一 (host 应避免
   * 这种状态; 但实现上不强制约束, 由调用方语义决定)。
   *
   * 主要用例: desktop "收回" 按钮 — renderer 只知道 sessionId, 反查出
   * (channel, botContextId, userId) 才能调 detach + 通知对应的 IM 用户。
   */
  findByTarget(value: TValue): IdentityKey | null;

  /**
   * 写入 / 更新 binding。同 identity 上已有 binding 会被覆盖 (last-write-wins)。
   * 持久化 + 内存 Map 更新 + 触发 onChange 监听器, 三件事原子完成
   * (实现需保证: 持久化失败则不更新内存)。
   */
  attach(identity: IdentityKey, value: TValue): Promise<void>;

  /**
   * 删除 binding。identity 不存在时静默返回 (幂等)。
   */
  detach(identity: IdentityKey): Promise<void>;

  /**
   * 订阅 binding 变更。返回取消订阅函数。多 listener 共存 (类似 EventEmitter)。
   *
   * 触发时机: attach() / detach() 完成后同步触发所有 listener。
   * 用例: host 用它 broadcast IPC 给 renderer, 让 desktop UI 实时渲染 mask /
   * 收回按钮的可见性。
   */
  onChange(listener: BindingChangeListener<TValue>): () => void;
}
