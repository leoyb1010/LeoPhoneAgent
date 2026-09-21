import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodePermissionRequest, ZCodeStreamEvent, ZCodeTaskMode } from "@zcode/shared";

import { ensureLeoHome, leoPath } from "./leoPaths.js";

export interface TelegramConfig {
  enabled: boolean;
  token: string;
  apiBase: string;
  allowedChats: number[];
  defaultCwd: string;
  /** 与 ZCode 的权限档位一致(ZCodeTaskMode)。Telegram 默认 build:改文件不用问,危险动作仍会推审批卡。 */
  mode: ZCodeTaskMode;
}

const DEFAULTS: TelegramConfig = {
  enabled: false,
  token: "",
  apiBase: "https://api.telegram.org",
  allowedChats: [],
  defaultCwd: process.env["HOME"] ?? "/",
  mode: "build",
};

function configFile(): string {
  return leoPath("channels.json");
}

export function readTelegramConfig(): TelegramConfig {
  try {
    if (!existsSync(configFile())) return { ...DEFAULTS };
    const raw = JSON.parse(readFileSync(configFile(), "utf8")) as { telegram?: Partial<TelegramConfig> };
    return { ...DEFAULTS, ...raw.telegram };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeTelegramConfig(next: TelegramConfig): void {
  ensureLeoHome();
  let all: Record<string, unknown> = {};
  try {
    if (existsSync(configFile())) all = JSON.parse(readFileSync(configFile(), "utf8")) as Record<string, unknown>;
  } catch {
    all = {};
  }
  all["telegram"] = next;
  writeFileSync(configFile(), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
}

interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number }; message_id: number } };
}

interface PendingPermission {
  chatId: number;
  taskId: string;
  request: ZCodePermissionRequest;
}

type Logger = { info: (msg: string, meta?: unknown) => void; warn: (msg: string, meta?: unknown) => void };

/**
 * [leo] Telegram 通道。在聊天里说一句话 = 在这台 Mac 上开一条 ZCode 会话;
 * 需要批准的操作以内联按钮推过去,点一下就是应答 —— 和桌面上的审批是同一套
 * 权限系统(ZCodeTaskService.respondPermission),不另搞一套策略。
 *
 * token 只存在本机 `~/.leoagent/channels.json`(0600),不进日志、不进仓库。
 */
export class TelegramChannel {
  private config: TelegramConfig = readTelegramConfig();
  private offset = 0;
  private running = false;
  private pairingCode: string | null = null;
  private readonly chatTasks = new Map<number, string>();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly buffers = new Map<string, string>();
  private readonly subscribed = new Set<string>();

  constructor(
    private readonly taskService: IZCodeTaskService,
    private readonly logger: Logger,
  ) {}

  status(): { enabled: boolean; running: boolean; chats: number[]; hasToken: boolean; pairingCode: string | null } {
    return {
      enabled: this.config.enabled,
      running: this.running,
      chats: [...this.config.allowedChats],
      hasToken: this.config.token.length > 0,
      pairingCode: this.pairingCode,
    };
  }

  update(patch: Partial<TelegramConfig>): void {
    this.config = { ...this.config, ...patch };
    writeTelegramConfig(this.config);
    if (this.config.enabled && this.config.token) void this.start();
    else this.stop();
  }

  newPairingCode(): string {
    this.pairingCode = String(Math.floor(100000 + Math.random() * 900000));
    return this.pairingCode;
  }

  removeChat(chatId: number): void {
    this.config.allowedChats = this.config.allowedChats.filter((id) => id !== chatId);
    writeTelegramConfig(this.config);
  }

  async start(): Promise<void> {
    if (this.running || !this.config.enabled || !this.config.token) return;
    this.running = true;
    this.logger.info("[leo/telegram] channel started");
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.api<TelegramUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"],
        });
        for (const update of updates ?? []) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (error) {
        // 长轮询断了就歇一会儿再来:网络抖动不该把通道打死。
        this.logger.warn("[leo/telegram] poll failed", { error: String(error) });
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private async api<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
    const response = await fetch(`${this.config.apiBase}/bot${this.config.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { ok: boolean; result?: T };
    return payload.ok ? (payload.result ?? null) : null;
  }

  private async send(chatId: number, text: string, replyMarkup?: unknown): Promise<void> {
    await this.api("sendMessage", {
      chat_id: chatId,
      text: text.slice(0, 4000),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  private authorized(chatId: number): boolean {
    return this.config.allowedChats.includes(chatId);
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const message = update.message;
    const text = message?.text?.trim();
    if (!message || !text) return;
    const chatId = message.chat.id;

    if (text.startsWith("/pair")) {
      const code = text.split(/\s+/)[1] ?? "";
      if (this.pairingCode && code === this.pairingCode) {
        if (!this.config.allowedChats.includes(chatId)) this.config.allowedChats.push(chatId);
        writeTelegramConfig(this.config);
        this.pairingCode = null;
        await this.send(chatId, "配对成功。直接说话就是在这台 Mac 上开一条会话;/new 开新的,/stop 停当前这条。");
      } else {
        await this.send(chatId, "配对码不对。到桌面「设置 → 通道」重新生成一个。");
      }
      return;
    }

    if (!this.authorized(chatId)) {
      await this.send(chatId, "这个聊天还没配对。到桌面「设置 → 通道」生成配对码,然后发 /pair 你的码。");
      return;
    }

    if (text === "/status") {
      const taskId = this.chatTasks.get(chatId);
      await this.send(chatId, taskId ? `当前会话:${taskId}\n目录:${this.config.defaultCwd}` : "现在没有会话。说句话就开一条。");
      return;
    }
    if (text === "/new") {
      this.chatTasks.delete(chatId);
      await this.send(chatId, "好,下一句话开一条新会话。");
      return;
    }
    if (text === "/stop") {
      const taskId = this.chatTasks.get(chatId);
      if (!taskId) {
        await this.send(chatId, "现在没有在跑的会话。");
        return;
      }
      await this.taskService.stopGeneration({ taskId, workspacePath: this.config.defaultCwd });
      await this.send(chatId, "已停止。上下文保留,可以接着说。");
      return;
    }
    if (text === "/help" || text === "/start") {
      await this.send(chatId, "说一句话就是在这台 Mac 上开会话。/new 换新会话,/stop 停这一轮,/status 看当前会话。");
      return;
    }

    await this.runPrompt(chatId, text);
  }

  private async runPrompt(chatId: number, prompt: string): Promise<void> {
    let taskId = this.chatTasks.get(chatId);
    if (!taskId) {
      const created = await this.taskService.createTask({
        workspacePath: this.config.defaultCwd,
        mode: this.config.mode,
      });
      taskId = created.taskId;
      this.chatTasks.set(chatId, taskId);
      this.subscribe(chatId, taskId);
      await this.send(chatId, `开了一条会话(${this.config.defaultCwd})。`);
    }
    this.buffers.set(taskId, "");
    await this.taskService.sendPrompt({
      taskId,
      traceId: randomUUID(),
      content: prompt,
      clientLabel: "telegram",
    });
  }

  /** 一条会话只订阅一次:流里出文字、要批准、跑完了,分别对应发消息、发按钮、发结果。 */
  private subscribe(chatId: number, taskId: string): void {
    if (this.subscribed.has(taskId)) return;
    this.subscribed.add(taskId);
    this.taskService.onDynamicStreamEvent(taskId)((event: ZCodeStreamEvent) => {
      void this.onStreamEvent(chatId, taskId, event);
    });
  }

  private async onStreamEvent(chatId: number, taskId: string, event: ZCodeStreamEvent): Promise<void> {
    if (event.type === "agent_message_chunk") {
      this.buffers.set(taskId, (this.buffers.get(taskId) ?? "") + event.content);
      return;
    }
    if (event.type === "permission_request") {
      const request = event;
      this.pending.set(request.requestId, { chatId, taskId, request });
      const keyboard = {
        inline_keyboard: [
          request.options.slice(0, 4).map((option) => ({
            text: option.name,
            callback_data: `p|${request.requestId}|${option.optionId}`.slice(0, 64),
          })),
        ],
      };
      await this.send(chatId, `需要你确认:\n${request.title ?? request.kind}\n${request.description}`, keyboard);
      return;
    }
    if (event.type === "task_complete") {
      const reply = (this.buffers.get(taskId) ?? "").trim();
      this.buffers.set(taskId, "");
      await this.send(chatId, reply || `(这一轮没有文字回复,stopReason=${event.stopReason})`);
    }
  }

  private async handleCallback(query: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
    const [tag, requestId, optionId] = (query.data ?? "").split("|");
    if (tag !== "p" || !requestId || !optionId) return;
    const entry = this.pending.get(requestId);
    if (!entry || !this.authorized(entry.chatId)) return;
    this.pending.delete(requestId);
    const option = entry.request.options.find((candidate) => candidate.optionId === optionId);
    await this.taskService.respondPermission({
      taskId: entry.taskId,
      workspacePath: this.config.defaultCwd,
      requestId,
      optionId,
      response: option?.response ?? ("deny" as never),
    });
    await this.api("answerCallbackQuery", { callback_query_id: query.id, text: option?.name ?? "已应答" });
    if (query.message) {
      await this.api("editMessageText", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        text: `已应答:${option?.name ?? optionId}`,
      });
    }
  }
}
