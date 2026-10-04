/**
 * UI 请求生命周期，不拥有任务/cache。卸载或更新查询后旧回执只能结束自己的Promise，
 * 不能覆盖当前列表、错误或loading；真正的请求仍由既有registry执行。
 */
export function createTaskListLoadCoordinator() {
  let generation = 0;
  let active = true;
  return {
    activate() { active = true; },
    invalidate() { generation += 1; },
    dispose() { active = false; generation += 1; },
    async run<T>(callbacks: {
      load: () => Promise<T>;
      onLoading: (loading: boolean) => void;
      onResult: (result: T) => void;
      onError: (error: unknown) => void;
    }): Promise<void> {
      if (!active) return;
      const request = ++generation;
      const current = () => active && generation === request;
      callbacks.onLoading(true);
      try {
        const result = await callbacks.load();
        if (current()) callbacks.onResult(result);
      } catch (error) {
        if (current()) callbacks.onError(error);
      } finally {
        if (current()) callbacks.onLoading(false);
      }
    },
  };
}
