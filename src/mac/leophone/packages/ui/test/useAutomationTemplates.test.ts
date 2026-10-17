// @vitest-environment jsdom
import { act } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientSceneConfig,
  ClientScenesResponse,
  IClientScenesService,
} from "@zcode/services";
import { useAutomationTemplates } from "@/settings/useAutomationTemplates.js";

const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock("@/logger.js", () => ({
  logger: { warn: loggerWarn },
}));

// [leo] Off-peak task UI was removed (Mac 1.9); the catalog only exposes scheduled templates,
// so the fixture uses a scheduled-task scene instead of the upstream off-peak-task scene.
function scheduledResponse(id: string, title: string): ClientScenesResponse {
  return {
    code: 0,
    msg: "success",
    data: [
      {
        namespace: "zcode",
        scene: "scheduled-task",
        options: {
          prompts: {
            id: "prompts",
            type: "prompts",
            contents: {},
            items: [
              {
                id,
                type: "prompts",
                contents: { en: `${title} prompt` },
                labels: { en: title },
                defaults: { cronExpr: ["cron-daily"] },
                on_finish: null,
                img: null,
              },
            ],
            refer: "",
            templates: {},
          },
          cronExpr: {
            id: "cronExpr",
            type: "cronExpr",
            contents: {},
            items: [
              {
                id: "cron-daily",
                type: "cronExpr",
                contents: { en: "0 9 * * *" },
                labels: { en: "Daily" },
                on_finish: null,
                img: null,
              },
            ],
            refer: "",
            templates: {},
          },
        },
        created_at: 0,
        updated_at: 0,
      } as ClientSceneConfig,
    ],
  };
}

function service(list: () => Promise<ClientScenesResponse>): IClientScenesService {
  return { list };
}

beforeEach(() => {
  loggerWarn.mockReset();
});

describe("useAutomationTemplates", () => {
  it("keeps loading true until a successful Client Scenes response settles", async () => {
    let resolveList!: (response: ClientScenesResponse) => void;
    const list = vi.fn(
      () =>
        new Promise<ClientScenesResponse>((resolve) => {
          resolveList = resolve;
        }),
    );
    const clientScenesService = service(list);
    const { result } = renderHook(() => useAutomationTemplates(clientScenesService));

    expect(result.current.loading).toBe(true);
    await act(async () => {
      resolveList(scheduledResponse("item-loaded", "Loaded"));
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.scheduled[0]?.id).toBe("item-loaded");
  });

  it("returns an empty remote catalog when Client Scenes fails", async () => {
    const list = vi.fn().mockRejectedValue(new Error("offline"));
    const clientScenesService = service(list);
    const { result } = renderHook(() => useAutomationTemplates(clientScenesService));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scheduled).toEqual([]);
    expect(loggerWarn).toHaveBeenCalledWith(
      "[automation-templates] Client Scenes 请求失败，保留手动创建入口",
      { error: "offline" },
    );
  });

  it("ends loading with an empty remote catalog after a business failure", async () => {
    const list = vi.fn().mockResolvedValue({
      code: 5001,
      msg: "scene unavailable",
      data: [],
    } satisfies ClientScenesResponse);
    const clientScenesService = service(list);
    const { result } = renderHook(() => useAutomationTemplates(clientScenesService));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.scheduled).toEqual([]);
  });

  it("ignores a late response from the previous service attachment", async () => {
    let resolveFirst!: (response: ClientScenesResponse) => void;
    const first = service(
      () =>
        new Promise<ClientScenesResponse>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const second = service(async () => scheduledResponse("item-new", "New"));
    const { result, rerender } = renderHook(
      ({ currentService }) => useAutomationTemplates(currentService),
      { initialProps: { currentService: first } },
    );

    rerender({ currentService: second });
    await waitFor(() => expect(result.current.scheduled[0]?.id).toBe("item-new"));
    expect(result.current.loading).toBe(false);
    await act(async () => {
      resolveFirst(scheduledResponse("item-old", "Old"));
      await Promise.resolve();
    });

    expect(result.current.scheduled[0]?.id).toBe("item-new");
    expect(result.current.loading).toBe(false);
  });
});
