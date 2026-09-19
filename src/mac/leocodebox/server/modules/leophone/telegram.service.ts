import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EVENT_APPROVAL_REQUEST,
  EVENT_MESSAGE_DELTA,
  EVENT_RUN_CANCELLED,
  EVENT_RUN_COMPLETED,
  EVENT_RUN_FAILED,
  EVENT_USER_MESSAGE,
} from './harness-dialects.js';
import { addHarnessEventSink, getHarnessManager, isLiveHarnessStatus, type HarnessSession } from './harness-session.service.js';
import { LEOAGENT_HOME } from './leoagent-home.js';
import { normalizePolicy } from './pi-runtime.js';

// Telegram 通道:在群里 / 私聊里 @机器人 说一句话 = 在这台 Mac 上开一条 pi 会话;
// 会话里的「需要确认」以同一张卡(inline keyboard)推到 Telegram,点按钮就是批准。
//
// 选 Telegram 先做,是因为 Bot API 长轮询不需要公网回调 —— 家里的 Mac 也能直接用。
// 配对:设置页生成 6 位码,在 Telegram 里发 `/pair 123456`;没配对的 chat 一律不理。
// 事件来源:HarnessSession 提交到日志后的外推(approval.request / run.completed /
// run.failed / run.cancelled),与推给手机的是同一批事件。

export type TelegramConfig = {
  enabled: boolean;
  token: string;
  apiBase: string;
  allowedChats: number[];
  defaultCwd: string;
  model: string | null;
  policy: string;
};

type ChannelsFile = { telegram?: Partial<TelegramConfig> };

const CONFIG_PATH = path.join(LEOAGENT_HOME, 'channels.json');
const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_REPLY = 3500;

function defaults(): TelegramConfig {
  return { enabled: false, token: '', apiBase: 'https://api.telegram.org', allowedChats: [], defaultCwd: '~', model: null, policy: 'default' };
}

export function readTelegramConfig(): TelegramConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as ChannelsFile;
    const t = parsed.telegram ?? {};
    return {
      ...defaults(),
      enabled: Boolean(t.enabled),
      token: typeof t.token === 'string' ? t.token : '',
      apiBase: typeof t.apiBase === 'string' && t.apiBase ? t.apiBase : 'https://api.telegram.org',
      allowedChats: Array.isArray(t.allowedChats) ? t.allowedChats.map(Number).filter(Number.isFinite) : [],
      defaultCwd: typeof t.defaultCwd === 'string' && t.defaultCwd ? t.defaultCwd : '~',
      model: typeof t.model === 'string' && t.model ? t.model : null,
      policy: normalizePolicy(t.policy),
    };
  } catch {
    return defaults();
  }
}

export function writeTelegramConfig(next: TelegramConfig): void {
  fs.mkdirSync(LEOAGENT_HOME, { recursive: true, mode: 0o700 });
  let file: ChannelsFile = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as ChannelsFile; } catch { /* fresh */ }
  file.telegram = next;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
}

type TgMessage = { message_id: number; chat: { id: number; type: string; title?: string; username?: string }; text?: string; from?: { id: number; username?: string; first_name?: string } };
type TgCallback = { id: string; data?: string; message?: TgMessage; from?: { id: number } };
type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: TgCallback };

class TelegramChannel {
  private config = readTelegramConfig();
  private running = false;
  private abort: AbortController | null = null;
  private offset = 0;
  private botUsername: string | null = null;
  private lastError: string | null = null;
  private sinkInstalled = false;
  private pairingCode: string | null = null;
  private pairingExpires = 0;
  /** chat → 当前绑定的会话;会话 → chat。 */
  private chatSessions = new Map<number, string>();
  private sessionChats = new Map<string, number>();
  /** 短键 → 审批地址;Telegram 的 callback_data 只有 64 字节,塞不下会话 id + 审批 id。 */
  private approvalKeys = new Map<string, { sessionId: string; approvalId: string; chatId: number; messageId: number | null }>();

  status() {
    return {
      enabled: this.config.enabled,
      configured: Boolean(this.config.token),
      running: this.running,
      botUsername: this.botUsername,
      apiBase: this.config.apiBase,
      allowedChats: this.config.allowedChats,
      defaultCwd: this.config.defaultCwd,
      model: this.config.model,
      policy: this.config.policy,
      pairingCode: this.pairingCode && Date.now() < this.pairingExpires ? this.pairingCode : null,
      pairingExpiresAt: this.pairingCode ? this.pairingExpires : null,
      boundSessions: [...this.sessionChats.keys()],
      lastError: this.lastError,
    };
  }

  newPairingCode(): string {
    this.pairingCode = String(crypto.randomInt(100000, 999999));
    this.pairingExpires = Date.now() + PAIRING_TTL_MS;
    return this.pairingCode;
  }

  update(patch: Partial<TelegramConfig>): TelegramConfig {
    const next: TelegramConfig = {
      ...this.config,
      ...(patch.enabled != null ? { enabled: Boolean(patch.enabled) } : {}),
      ...(typeof patch.token === 'string' ? { token: patch.token.trim() } : {}),
      ...(typeof patch.apiBase === 'string' && patch.apiBase.trim() ? { apiBase: patch.apiBase.trim().replace(/\/+$/, '') } : {}),
      ...(Array.isArray(patch.allowedChats) ? { allowedChats: patch.allowedChats.map(Number).filter(Number.isFinite) } : {}),
      ...(typeof patch.defaultCwd === 'string' && patch.defaultCwd.trim() ? { defaultCwd: patch.defaultCwd.trim() } : {}),
      ...(patch.model !== undefined ? { model: patch.model ? String(patch.model) : null } : {}),
      ...(patch.policy != null ? { policy: normalizePolicy(patch.policy) } : {}),
    };
    this.config = next;
    writeTelegramConfig(next);
    void this.restart();
    return next;
  }

  removeChat(chatId: number): void {
    this.config.allowedChats = this.config.allowedChats.filter((id) => id !== chatId);
    writeTelegramConfig(this.config);
    const bound = this.chatSessions.get(chatId);
    if (bound) { this.chatSessions.delete(chatId); this.sessionChats.delete(bound); }
  }

  start(): void {
    this.installSink();
    if (this.running || !this.config.enabled || !this.config.token) return;
    this.running = true;
    this.lastError = null;
    this.abort = new AbortController();
    void this.loop(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    this.abort = null;
  }

  private async restart(): Promise<void> {
    await this.stop();
    this.botUsername = null;
    this.start();
  }

  // -- 长轮询 -----------------------------------------------------------------

  private async api<T = unknown>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.config.apiBase}/bot${this.config.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    const payload = await response.json() as { ok: boolean; result?: T; description?: string };
    if (!payload.ok) throw new Error(payload.description || `telegram ${method} failed`);
    return payload.result as T;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    try {
      const me = await this.api<{ username?: string }>('getMe', {}, signal);
      this.botUsername = me.username ?? null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    while (this.running && !signal.aborted) {
      try {
        const updates = await this.api<TgUpdate[]>('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, signal);
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          try {
            if (update.message) await this.onMessage(update.message);
            else if (update.callback_query) await this.onCallback(update.callback_query);
          } catch (error) {
            this.lastError = error instanceof Error ? error.message : String(error);
          }
        }
        this.lastError = null;
      } catch (error) {
        if (signal.aborted) return;
        this.lastError = error instanceof Error ? error.message : String(error);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  private isAllowed(chatId: number): boolean {
    return this.config.allowedChats.includes(chatId);
  }

  private async send(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<number | null> {
    try {
      const result = await this.api<{ message_id: number }>('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), ...extra });
      return result.message_id;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  private async onMessage(message: TgMessage): Promise<void> {
    const chatId = message.chat.id;
    const text = (message.text ?? '').trim();
    if (!text) return;
    // 去掉群里的 @机器人 前缀
    const bare = this.botUsername ? text.replace(new RegExp(`@${this.botUsername}\\b`, 'g'), '').trim() : text;

    if (bare.startsWith('/pair')) {
      const code = bare.replace('/pair', '').trim();
      if (this.pairingCode && Date.now() < this.pairingExpires && code === this.pairingCode) {
        if (!this.isAllowed(chatId)) {
          this.config.allowedChats = [...this.config.allowedChats, chatId];
          writeTelegramConfig(this.config);
        }
        this.pairingCode = null;
        await this.send(chatId, `已配对。直接说话就是在 ${this.hostLabel()} 上开一条新会话;会话里的确认会推到这里。\n命令:/new 开新会话 · /stop 停止 · /status 状态`);
      } else {
        await this.send(chatId, '配对码不对或已过期。在 leocodebox → 通道 里重新生成一个。');
      }
      return;
    }
    if (!this.isAllowed(chatId)) {
      await this.send(chatId, `这个聊天还没配对(chat id ${chatId})。在 leocodebox → 通道 里生成配对码,然后发我:/pair 123456`);
      return;
    }

    if (bare === '/status') {
      const session = this.boundSession(chatId);
      await this.send(chatId, session ? `会话 ${session.title || session.sessionId}\n状态:${session.status} · 模型:${session.model ? `${session.model.provider}/${session.model.modelId}` : '默认'} · 审批:${session.policy}` : '这个聊天还没绑定会话;直接说话就会开一条。');
      return;
    }
    if (bare === '/stop') {
      const session = this.boundSession(chatId);
      if (session && isLiveHarnessStatus(session.status)) { await session.stop(); await this.send(chatId, '已停止。'); }
      else await this.send(chatId, '没有在跑的会话。');
      return;
    }
    if (bare === '/help' || bare === '/start') {
      await this.send(chatId, `直接说话 = 给当前会话发消息(没有会话就新开一条)\n/new 内容 = 强制开一条新会话\n/stop = 停止当前会话\n/status = 看状态`);
      return;
    }

    const forceNew = bare.startsWith('/new');
    const prompt = forceNew ? bare.replace('/new', '').trim() : bare;
    if (!prompt) { await this.send(chatId, '/new 后面跟上要做的事。'); return; }

    const bound = this.boundSession(chatId);
    if (!forceNew && bound && isLiveHarnessStatus(bound.status)) {
      try {
        await bound.send(prompt);
      } catch (error) {
        await this.send(chatId, `发不进去:${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    try {
      const session = await getHarnessManager().create({
        harness: 'pi', cwd: this.config.defaultCwd, prompt,
        model: this.config.model ? parseModel(this.config.model) : null, policy: this.config.policy,
      });
      this.chatSessions.set(chatId, session.sessionId);
      this.sessionChats.set(session.sessionId, chatId);
      await this.send(chatId, `已在 ${this.hostLabel()} 上开了一条会话(${session.sessionId.slice(0, 11)}…),跑起来了。`);
    } catch (error) {
      await this.send(chatId, `开会话失败:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async onCallback(callback: TgCallback): Promise<void> {
    const data = callback.data ?? '';
    const [kind, key, choice] = data.split('|');
    if (kind !== 'ap' || !key || !choice) return;
    const target = this.approvalKeys.get(key);
    const answer = async (text: string) => {
      try { await this.api('answerCallbackQuery', { callback_query_id: callback.id, text }); } catch { /* best effort */ }
    };
    if (!target) { await answer('这张卡已过期'); return; }
    const session = getHarnessManager().get(target.sessionId);
    if (!session) { await answer('会话已不在'); return; }
    const delivered = await session.respondToApproval(choice, target.approvalId);
    if (!delivered) { await answer('没送到:会话可能已经不等了'); return; }
    this.approvalKeys.delete(key);
    const label = choice === 'deny' ? '已拒绝' : choice === 'session' ? '已批准,本会话内相同范围不再问' : '已批准一次';
    await answer(label);
    if (target.messageId != null && callback.message?.text) {
      try {
        await this.api('editMessageText', { chat_id: target.chatId, message_id: target.messageId, text: `${callback.message.text}\n\n✓ ${label}(Telegram)` });
      } catch { /* 编辑失败不影响审批本身 */ }
    }
  }

  // -- 会话事件 → 通道 --------------------------------------------------------

  private installSink(): void {
    if (this.sinkInstalled) return;
    this.sinkInstalled = true;
    addHarnessEventSink((event) => { void this.onEvent(event); });
  }

  private async onEvent(event: Record<string, unknown>): Promise<void> {
    if (!this.running) return;
    const sessionId = String(event.session_id ?? '');
    const name = String(event.event ?? '');
    const session = getHarnessManager().get(sessionId);
    if (!session) return;
    const boundChat = this.sessionChats.get(sessionId);
    // 审批卡:绑定了 chat 就发给它;没绑定的(Mac 上开的)也推给所有配对的 chat —— 同一张卡,任一端处理。
    if (name === EVENT_APPROVAL_REQUEST) {
      const targets = boundChat != null ? [boundChat] : this.config.allowedChats;
      const approvalId = String(event.approval_id ?? '');
      const choices = Array.isArray(event.choices) ? event.choices.map(String) : ['once', 'deny'];
      const command = String(event.command ?? '');
      const text = `需要确认 · ${session.title || '会话'}\n要在 ${String(event.host || this.hostLabel())} 上执行${event.tool ? ` · ${String(event.tool)}` : ''}:\n${command.slice(0, 1500)}`;
      for (const chatId of targets) {
        const key = crypto.randomBytes(6).toString('base64url');
        const buttons = [
          ...(choices.includes('once') ? [{ text: '批准一次', callback_data: `ap|${key}|once` }] : []),
          ...(choices.includes('session') ? [{ text: '本会话允许', callback_data: `ap|${key}|session` }] : []),
          ...(choices.includes('always') ? [{ text: '总是允许', callback_data: `ap|${key}|always` }] : []),
          ...(choices.includes('deny') ? [{ text: '拒绝', callback_data: `ap|${key}|deny` }] : []),
        ];
        const messageId = await this.send(chatId, text, { reply_markup: { inline_keyboard: [buttons] } });
        this.approvalKeys.set(key, { sessionId, approvalId, chatId, messageId });
      }
      return;
    }
    if (boundChat == null) return;
    if (name === EVENT_RUN_COMPLETED) {
      const reply = await this.collectReply(session);
      await this.send(boundChat, reply ? reply.slice(0, MAX_REPLY) : '完成了,这轮没有文字回复。');
    } else if (name === EVENT_RUN_FAILED) {
      await this.send(boundChat, `失败:${String(event.error ?? '未知错误').slice(0, 800)}`);
    } else if (name === EVENT_RUN_CANCELLED) {
      await this.send(boundChat, '已停止。');
    }
  }

  /** 从日志把最后一条用户消息之后的模型文字拼回来 —— 通道里要看的是答案,不是流水。 */
  private async collectReply(session: HarnessSession): Promise<string> {
    await session.flushJournal();
    let lastUserSeq = 0;
    const deltas: Array<{ seq: number; text: string }> = [];
    for await (const event of session.replay(0)) {
      const seq = Number(event.seq ?? 0);
      if (event.event === EVENT_USER_MESSAGE) { lastUserSeq = seq; deltas.length = 0; }
      else if (event.event === EVENT_MESSAGE_DELTA && seq > lastUserSeq) deltas.push({ seq, text: String(event.delta ?? '') });
    }
    return deltas.map((d) => d.text).join('').trim();
  }

  private boundSession(chatId: number): HarnessSession | null {
    const id = this.chatSessions.get(chatId);
    return id ? getHarnessManager().get(id) ?? null : null;
  }

  private hostLabel(): string {
    return process.env.LEO_HOST || os.hostname();
  }
}

function parseModel(input: string): { provider: string; modelId: string } | null {
  const slash = input.indexOf('/');
  return slash > 0 ? { provider: input.slice(0, slash), modelId: input.slice(slash + 1) } : null;
}

export const telegramChannel = new TelegramChannel();
