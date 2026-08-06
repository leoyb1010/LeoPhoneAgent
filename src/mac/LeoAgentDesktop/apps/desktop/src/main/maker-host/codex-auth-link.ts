/**
 * apps/desktop/src/main/maker-host/codex-auth-link.ts
 *
 * Codex auth.json 共享硬链的"安全替换"原语 —— 从 auth-adapters 的 reconcile 流程里拆出来,
 * 不依赖 Electron, 可单测。
 *
 * 背景 (2026-06-18 线上踩坑):
 *   reconcile 把 codex-home/auth.json 替换成指向 ~/.codex/auth.json 的硬链时, 原实现用**固定**
 *   sidecar 名 `auth.json.linktmp` + 「rm myAuth → rename tmp→myAuth」两步。而 reconcile 有多个
 *   调用点 (构造 / getState / getAuthEnv / getAccessToken / getAccountId / 登录成功) 且无串行化,
 *   并发跑时撞同一个 sidecar:
 *     - 两个并发 link 同名 tmp → 第二个 `EEXIST`
 *     - 一个已把 tmp rename 走 → 另一个 rename 同名 tmp → `ENOENT`
 *   更糟: rename 失败发生在 `rm(myAuth)` 之后, 原 catch 只清 tmp、不重建 myAuth, 会留下
 *   "myAuth 被删却没建回"的空窗 → 用户凭空丢失登录态、被迫重登, 且 reconcile 持续失败陷入循环。
 *
 * 这里的修复:
 *   1. 每次调用用**唯一** sidecar 名 (pid + 自增计数), 同进程内并发调用各用各的, 从根上消除撞名。
 *   2. rename 失败且 myAuth 已不在时, 尽力用 link / copy 把 myAuth 从 systemAuth 重建回来 ——
 *      只要 systemAuth 有效, 用户永远不会凭空丢失 auth.json。
 *
 * 注意: 本模块只管"安全替换"这一件事, 不做账号比对 / inode 短路 / suppress 标记等判定 ——
 * 那些仍由 auth-adapters 的 reconcile 主流程负责。
 */
import { promises as fsp, existsSync } from 'node:fs';

/**
 * relinkSharedCodexAuth 的结果分类:
 *   - linked              成功: myAuth 现在和 systemAuth 同 inode (硬链共享, refresh 写回两端生效)
 *   - link-unsupported    连 sidecar 硬链都建不出 (跨分区 / 权限) → myAuth 一字未动, 安全回落隔离模式
 *   - swap-failed-intact  替换失败但 myAuth 仍在 (多半是并发的另一次 reconcile 已抢先放好)
 *   - recovered           替换中途 myAuth 一度丢失, 已从 systemAuth 重建 (硬链或独立拷贝)
 *   - lost                替换失败且无法重建 (systemAuth 也读不了) → 需要用户重新登录
 */
export type RelinkResultKind =
  | 'linked'
  | 'link-unsupported'
  | 'swap-failed-intact'
  | 'recovered'
  | 'lost';

export interface RelinkOutcome {
  kind: RelinkResultKind;
  /** 失败路径上的底层错误, 供调用方打日志; linked 时为 undefined。 */
  error?: Error;
}

/** 同进程内自增, 保证并发调用拿到互不相同的 sidecar 路径。 */
let sidecarCounter = 0;

/**
 * 原子地把 myAuth 替换成指向 systemAuth 的硬链。
 *
 * 调用方需自行保证 systemAuth 存在、且两边是同账号 (本函数不做账号比对)。
 * 并发安全: 每次调用使用唯一 sidecar, 不会和同进程内其它调用撞同名临时文件。
 */
export async function relinkSharedCodexAuth(
  systemAuth: string,
  myAuth: string,
): Promise<RelinkOutcome> {
  // 唯一 sidecar 名 (pid + 自增计数): 同进程内并发 reconcile 各用各的, 不再撞 EEXIST / ENOENT。
  const sidecar = `${myAuth}.${process.pid}.${sidecarCounter++}.linktmp`;

  // 1. 先把 sidecar 硬链建出来 —— 失败 (跨分区 / 权限) 时 myAuth 完全没动, 安全回落。
  try {
    await fsp.link(systemAuth, sidecar);
  } catch (error) {
    return { kind: 'link-unsupported', error: error as Error };
  }

  // 2. 用 sidecar 覆盖 myAuth。Windows 的 rename 不能覆盖已存在目标, 所以先删 myAuth 再 rename。
  try {
    await fsp.rm(myAuth, { force: true });
    await fsp.rename(sidecar, myAuth);
    // POSIX 上若 sidecar 与 myAuth 已是同一 inode (并发的另一次替换已把 myAuth 建成共享硬链),
    // rename 是成功的 no-op、不会移走 sidecar —— 顺手清掉, 避免并发下 .linktmp 残留堆积。
    await fsp.rm(sidecar, { force: true }).catch(() => undefined);
    return { kind: 'linked' };
  } catch (error) {
    // 替换失败: 先清掉 sidecar, 再判断 myAuth 是否还在。
    await fsp.rm(sidecar, { force: true }).catch(() => undefined);
    if (existsSync(myAuth)) {
      // 危险窗口没真正发生 (myAuth 还在) —— 多半是并发的另一次替换已抢先放好, 无需补救。
      return { kind: 'swap-failed-intact', error: error as Error };
    }
    // myAuth 被删却没换上 → 绝不能让用户凭空丢登录态, 尽力从 systemAuth 重建。
    const recovered = await recoverCodexAuth(systemAuth, myAuth);
    return { kind: recovered ? 'recovered' : 'lost', error: error as Error };
  }
}

/**
 * myAuth 在替换中途丢失时的兜底重建:
 *   - 先试硬链 (保持和 systemAuth 共享, refresh 写回仍两端生效)
 *   - 跨分区 / 权限导致硬链失败时, 退化为独立拷贝 (等价隔离模式, 仍可正常登录使用)
 *
 * @returns 是否成功让 myAuth 重新存在
 */
export async function recoverCodexAuth(systemAuth: string, myAuth: string): Promise<boolean> {
  try {
    await fsp.link(systemAuth, myAuth);
    return true;
  } catch {
    /* 跨分区 / 权限 → 退化为独立拷贝 */
  }
  try {
    await fsp.copyFile(systemAuth, myAuth);
    return true;
  } catch {
    return false;
  }
}
