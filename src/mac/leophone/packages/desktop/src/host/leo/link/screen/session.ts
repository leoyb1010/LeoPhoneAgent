import { randomUUID } from "node:crypto";

import type { Caller } from "../session.js";
import {
  acceptRemoteCandidate,
  filterOfferCandidates,
  parseTurnConfig,
  rankAnswerCandidates,
  turnIceServers,
  type RemoteCandidate,
  type Resolver,
} from "./ice.js";
import type { ScreenSettings } from "./hostCapture.js";
import { mayViewScreen } from "./snapshot.js";

/**
 * [leo][WP-51] 看屏 R1 的信令状态机(Host 侧)。契约见 docs/specs/leo-screen.md「R1」。
 *
 *   GET    /screen/session            预检:ice_servers / tailnet_only / control
 *   POST   /screen/session            offer → answer(Mac 是应答方,答案里一次带全本机候选)
 *   POST   /screen/session/:id/ice    手机 trickle 候选
 *   GET    /screen/session/:id        状态与统计(编码器、帧率、码率、选中的候选对)
 *   DELETE /screen/session/:id        结束
 *
 * 状态:negotiating(30 秒内没连上主进程会自己关)→ connected → closed。同时只一路:别的设备来要 409;
 * 同一台设备再要就顶掉旧的(手机重进页面)。信令可走直连或中继(都是小 JSON),视频只走 WebRTC。
 * 策略在这里:开关、scope、只走 tailnet、ICE 排序;主进程只执行(经截屏 socket 的 /peer)。
 */

export interface ScreenSessionRequest {
  method: string;
  /** /screen/session 之后的部分:"" | "/<id>" | "/<id>/ice"。 */
  subpath: string;
  caller: Caller;
  body: unknown;
}

interface Reply {
  status: number;
  body: unknown;
}

type PeerCall = (payload: Record<string, unknown>) => Promise<Reply>;

interface Owned {
  owner: string;
  tailnetOnly: boolean;
}

const NEGOTIATION_MS = 30_000;
const MAX_OFFER_BYTES = 64 * 1024;
const MAX_CANDIDATES = 50;

function failure(status: number, code: string, message: string): Reply {
  return { status, body: { error: { message, code } } };
}

/** 主进程回的错误是 {code, message};统一成 link 的错误形状。 */
function fromPeer(reply: Reply): Reply {
  const body = (reply.body ?? {}) as { code?: unknown; message?: unknown };
  return failure(
    reply.status,
    typeof body.code === "string" ? body.code : "capture_unavailable",
    typeof body.message === "string" ? body.message : "看屏服务出错",
  );
}

/**
 * screen.control:同 screen.view 的设备范围,再加 Mac 上「允许手机操控」开关(默认关)。
 * 不存进授权表 —— 关掉开关立即对所有设备失效。
 */
export function mayControlScreen(caller: Caller, settings: ScreenSettings): boolean {
  return settings.control && mayViewScreen(caller);
}

const ownerOf = (caller: Caller) => caller.deviceId ?? caller.kind;

export function createScreenSessionService(deps: {
  peer: PeerCall;
  settings: () => Promise<ScreenSettings>;
  turnConfig: () => Promise<unknown>;
  now?: () => number;
  newId?: () => string;
  resolve?: Resolver;
}) {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => `scr_${randomUUID()}`);
  const owned = new Map<string, Owned>();

  /** 以主进程为准刷新:它那边已经断开 / 超时关掉的会话这里也删掉。 */
  async function live(): Promise<Set<string>> {
    const reply = await deps.peer({ op: "status" });
    const ids = new Set<string>();
    if (reply.status === 200) {
      const sessions = (reply.body as { sessions?: { id?: unknown }[] } | null)?.sessions ?? [];
      for (const entry of sessions) if (typeof entry.id === "string") ids.add(entry.id);
    }
    for (const id of owned.keys()) if (!ids.has(id)) owned.delete(id);
    return ids;
  }

  async function open(req: ScreenSessionRequest, settings: ScreenSettings): Promise<Reply> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const offer = body["offer"];
    if (typeof offer !== "string" || !offer.startsWith("v=") || offer.length > MAX_OFFER_BYTES)
      return failure(400, "bad_offer", "offer 必须是 SDP 字符串");
    const display = body["display"];
    if (display !== undefined && (typeof display !== "string" || !/^\d{1,20}$/.test(display)))
      return failure(404, "display_not_found", "没有这块屏幕");
    const fps = Number(body["max_fps"]);
    const maxFps = Number.isFinite(fps) ? Math.min(60, Math.max(1, Math.round(fps))) : 30;
    const edge = Number(body["max_edge"]);
    const maxEdge = Number.isFinite(edge) ? Math.min(4096, Math.max(640, Math.round(edge))) : 1920;

    await live();
    const owner = ownerOf(req.caller);
    if ([...owned.values()].some((entry) => entry.owner !== owner))
      return failure(409, "session_limit", "已经有一台设备在看这台 Mac 的屏幕");

    const control = body["control"] === true && mayControlScreen(req.caller, settings);
    const iceServers = settings.tailnetOnly
      ? []
      : turnIceServers(parseTurnConfig(await deps.turnConfig()), now());
    const sessionId = newId();
    const reply = await deps.peer({
      op: "open",
      sessionId,
      offer: filterOfferCandidates(offer, settings.tailnetOnly),
      ...(typeof display === "string" ? { displayId: display } : {}),
      maxFps,
      maxEdge,
      iceServers,
      control,
    });
    if (reply.status !== 200) return fromPeer(reply);
    // 主进程打开新会话时已把旧的(同一台设备的)关掉。
    owned.clear();
    const answer = String((reply.body as { answer?: unknown } | null)?.answer ?? "");
    const ranked = await rankAnswerCandidates(answer, {
      tailnetOnly: settings.tailnetOnly,
      ...(deps.resolve ? { resolve: deps.resolve } : {}),
    });
    if (settings.tailnetOnly && ranked.tiers.length === 0) {
      await deps.peer({ op: "close", sessionId });
      return failure(
        503,
        "no_tailnet_path",
        "Mac 上没有 Tailscale 地址,「只走 Tailscale」时连不上",
      );
    }
    owned.set(sessionId, { owner, tailnetOnly: settings.tailnetOnly });
    return {
      status: 200,
      body: {
        session_id: sessionId,
        answer: ranked.sdp,
        ice_servers: iceServers,
        expires_at: now() + NEGOTIATION_MS,
        control,
        tailnet_only: settings.tailnetOnly,
        candidate_tiers: ranked.tiers,
      },
    };
  }

  return async function handle(req: ScreenSessionRequest): Promise<Reply> {
    const settings = await deps.settings();
    if (!settings.enabled)
      return failure(
        403,
        "screen_disabled",
        "Mac 上没有打开「允许手机查看屏幕」(设置 → 连接手机 → 屏幕)",
      );
    if (!mayViewScreen(req.caller))
      return failure(403, "screen_scope_required", "这台设备没有查看屏幕的权限,请重新配对");
    const method = req.method.toUpperCase();
    if (req.subpath === "") {
      // 预检:手机建 RTCPeerConnection 之前先拿 ice_servers(含 TURN 短期凭据),offer 里才会有中转候选。
      if (method === "GET") {
        return {
          status: 200,
          body: {
            ice_servers: settings.tailnetOnly
              ? []
              : turnIceServers(parseTurnConfig(await deps.turnConfig()), now()),
            tailnet_only: settings.tailnetOnly,
            control: mayControlScreen(req.caller, settings),
          },
        };
      }
      if (method !== "POST") return failure(405, "method_not_allowed", "Method not allowed");
      return open(req, settings);
    }
    const match = /^\/(scr_[0-9a-f-]{36})(\/ice)?$/.exec(req.subpath);
    if (!match) return failure(404, "session_not_found", "看屏会话不存在");
    const sessionId = match[1]!;
    await live();
    const entry = owned.get(sessionId);
    // 别的设备的会话一律当不存在,不暴露 id 是否有效。
    if (!entry || entry.owner !== ownerOf(req.caller))
      return failure(404, "session_not_found", "看屏会话已结束");

    if (match[2]) {
      if (method !== "POST") return failure(405, "method_not_allowed", "Method not allowed");
      const raw = (req.body as { candidates?: unknown } | null)?.candidates;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CANDIDATES)
        return failure(400, "bad_candidates", `candidates 需要 1–${MAX_CANDIDATES} 个`);
      const candidates = raw
        .filter(
          (item): item is RemoteCandidate =>
            Boolean(item) && typeof (item as RemoteCandidate).candidate === "string",
        )
        .filter((item) => acceptRemoteCandidate(item, entry.tailnetOnly))
        .map((item) => ({
          candidate: item.candidate,
          sdpMid: typeof item.sdpMid === "string" ? item.sdpMid : null,
          sdpMLineIndex: typeof item.sdpMLineIndex === "number" ? item.sdpMLineIndex : null,
        }));
      if (candidates.length > 0) {
        const reply = await deps.peer({ op: "ice", sessionId, candidates });
        if (reply.status !== 200) return fromPeer(reply);
      }
      return {
        status: 200,
        body: { ok: true, accepted: candidates.length, dropped: raw.length - candidates.length },
      };
    }
    if (method === "DELETE") {
      await deps.peer({ op: "close", sessionId });
      owned.delete(sessionId);
      return { status: 200, body: { ok: true } };
    }
    if (method === "GET") {
      const reply = await deps.peer({ op: "stats", sessionId });
      if (reply.status !== 200) return fromPeer(reply);
      return { status: 200, body: { session_id: sessionId, ...(reply.body as object) } };
    }
    return failure(405, "method_not_allowed", "Method not allowed");
  };
}
