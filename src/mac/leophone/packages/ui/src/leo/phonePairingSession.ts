export type PairingResult =
  | { ok: true; data: { payload: string; machine: string; exp: number } }
  | { ok: false; error: string };
export type VisiblePairingCode = { image: string; machine: string; exp: number; direct: boolean };

type PairingSessionOptions = {
  issue(direct: boolean): Promise<PairingResult>;
  revoke?(payload: string): Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
  render(payload: string): Promise<string>;
  onCode(code: VisiblePairingCode | null): void;
  onPending(pending: boolean): void;
  onError(error: string | null): void;
  onCleanupError(): void;
};

/** 面板唯一的临时配对码所有者；关闭后的异步返回只能清理，不能再发布到 UI。 */
export function createPhonePairingSession(options: PairingSessionOptions) {
  let alive = true;
  let pending = false;
  let issuedPayload: string | null = null;
  let releasing: Promise<void> | null = null;

  const release = (): Promise<void> => {
    if (releasing) return releasing;
    const payload = issuedPayload;
    if (!payload) return Promise.resolve();
    releasing = (async () => {
      const result = await options.revoke?.(payload);
      if (result && !result.ok) throw new Error("未能撤销旧配对码，请重试；原码仍可能有效至到期");
      if (issuedPayload === payload) issuedPayload = null;
    })().finally(() => {
      releasing = null;
    });
    return releasing;
  };

  const generate = async (direct = false): Promise<void> => {
    // React 的 disabled 要等下一次渲染；同步闸门防止同一帧重复签发。
    if (!alive || pending) return;
    pending = true;
    options.onPending(true);
    options.onError(null);
    options.onCode(null);
    try {
      try {
        await release();
      } catch {
        if (alive) options.onError("未能撤销旧配对码，请重试；原码仍可能有效至到期");
        return;
      }
      if (!alive) return;
      const result = await options.issue(direct);
      if (!result.ok) {
        if (alive) options.onError(result.error);
        return;
      }
      issuedPayload = result.data.payload;
      if (!alive) {
        await release();
        return;
      }
      let image: string;
      try {
        image = await options.render(result.data.payload);
      } catch {
        await release();
        throw new Error("QR rendering failed");
      }
      if (!alive) return;
      options.onCode({ image, exp: result.data.exp, machine: result.data.machine, direct });
    } catch {
      if (alive) options.onError("生成配对码失败，请重试");
      else options.onCleanupError();
    } finally {
      pending = false;
      if (alive) options.onPending(false);
    }
  };

  return {
    generate,
    dispose() {
      alive = false;
      void release().catch(() => options.onCleanupError());
    },
  };
}
