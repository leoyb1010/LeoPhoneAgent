import { useRef } from 'react';

/**
 * 引用稳定化 hook:每轮渲染传入(可能是新引用的)派生值,内容与上一轮相等时
 * 返回上一轮的旧引用,让下游 useMemo 依赖 / React.memo props 比较得以短路。
 * ---------------------------------------------------------------------------
 * 背景(2026-07-18 首页列表重渲染风暴):useMemo 依赖挂在全局 storeVersion 上的
 * 派生索引每次 emit 都重建出内容相同的新 Map,home → sections → 全列表行随之
 * 整链重建。在派生点包一层本 hook,内容未变时引用不变,链路自然短路。
 * isEqual 必须是纯函数;比较成本要求远低于下游重建成本(Map 内容比较满足)。
 */
export function useStableValue<T>(value: T, isEqual: (a: T, b: T) => boolean): T {
  const ref = useRef(value);
  if (!Object.is(ref.current, value) && !isEqual(ref.current, value)) {
    ref.current = value;
  }
  return ref.current;
}
