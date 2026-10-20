/**
 * [leo] 终端 WebGL 渲染器的回收与上限（纯逻辑，不引 xterm，单测直接跑）。
 *
 * 以前卸载只 detach 不 dispose，终端一多就超过 Chromium 约 16 个 WebGL 上下文的上限；一次 contextLoss
 * （合盖唤醒也会触发）就把全局开关永久置假，之后所有终端都退回 DOM 渲染。现在：
 * - 终端离开界面（detach）时释放它的 WebGL，重新挂上再加载；
 * - 同时活跃的 WebGL 终端最多 limit 个，超出的用 DOM 渲染；
 * - contextLoss 只丢这一个终端的 WebGL，下次挂上照常重试；只有创建本身抛错（机器不支持）才整体停用。
 */
export interface WebglAddonLike {
  dispose(): void;
  onContextLoss(listener: () => void): unknown;
}

export interface WebglPoolOptions<Term> {
  limit: number;
  create: () => WebglAddonLike;
  load: (term: Term, addon: WebglAddonLike) => void;
  disabled?: () => boolean;
  warn?: (message: string, error?: unknown) => void;
}

export function createWebglPool<Term extends object>(options: WebglPoolOptions<Term>) {
  const active = new Map<Term, WebglAddonLike>();
  let unsupported = false;

  const release = (term: Term) => {
    const addon = active.get(term);
    if (!addon) return;
    active.delete(term);
    try {
      addon.dispose();
    } catch (error) {
      options.warn?.("[Terminal] WebGL dispose failed", error);
    }
  };

  return {
    /** 给终端挂上 WebGL（已挂、超上限、被关掉或不支持时什么也不做）。必须在 term.open() 之后调用。 */
    attach(term: Term): boolean {
      if (active.has(term)) return true;
      if (unsupported || options.disabled?.() || active.size >= options.limit) return false;
      let addon: WebglAddonLike;
      try {
        addon = options.create();
        // xterm 的 term.dispose() 也会调 addon.dispose()：包一层，任何途径释放都把名额还回来。
        const dispose = addon.dispose.bind(addon);
        addon.dispose = () => {
          if (active.get(term) === addon) active.delete(term);
          dispose();
        };
        addon.onContextLoss(() => {
          options.warn?.("[Terminal] WebGL context lost, falling back to DOM renderer until next attach");
          release(term);
        });
        active.set(term, addon);
        options.load(term, addon);
        return true;
      } catch (error) {
        active.delete(term);
        unsupported = true;
        options.warn?.("[Terminal] WebGL renderer unavailable, using DOM renderer", error);
        return false;
      }
    },
    /** 终端离开界面：释放它的 WebGL 上下文（xterm 自动回到 DOM 渲染，内容与滚动位置不变）。 */
    release,
    activeCount: () => active.size,
  };
}
