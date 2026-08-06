/**
 * 穷尽性断言:用在 discriminated-union 的 switch/if 链末尾。所有变体都处理完后,剩余类型应为 `never`;
 * 若将来给 union 加了新变体却忘了处理某个 dispatch 点,该处传入的不再是 `never` → **typecheck 直接报错**,
 * 把"手动审 N 个 dispatch 点"变成编译器保证(见 RenderItemView / messageGallery 的 default 分支)。
 * 运行时兜底:真到了这步(理论不该)抛错而非静默渲染错乱。
 */
export function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(value)}`);
}

/**
 * 渲染 / useMemo 热路径专用的穷尽性兜底:遇到未知变体时记一条 error 并**返回(不 throw)**——render 路径
 * 无外层 ErrorBoundary,throw 会让整列/相册崩。入参仍是 `never`:给 union 加变体却漏处理 → typecheck 报错,
 * 保留编译期穷尽性价值(只是运行时降级为 log+skip,调用方让 node 保持空 / gallery 跳过)。
 * 沿用 mobile 既有 console.* 日志约定(见 DeviceLinkContext)。
 */
export function logUnhandledRenderItem(value: never): void {
  console.error('[render] unhandled render item variant:', value);
}
