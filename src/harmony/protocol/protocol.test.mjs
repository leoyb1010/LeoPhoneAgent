import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseMachines,
  harnessURL,
  sameApiRoot,
  apiRootFromHarnessURL,
  isAndroidBody,
  isHarmonyBody,
  requireHttpsRoot,
  sanitizeKey,
  applyDiscovery,
} from "./relayMachines.ts";
import { encodePair, decodePair } from "./relayPair.ts";
import { resumeEnvelope, parseResumeEnvelope, applySeq, nextAfter } from "./resumeEnvelope.ts";
import { agentWsUrl, registerFrame, parseSseData, parseAgentFrame, respFrame } from "./relayOutbound.ts";
import { capabilitiesFromJson, parseRemoteTasks, sessionSummaryFromJson } from "./harnessTypes.ts";
import {
  requireProviderRoot,
  chatCompletionsUrl,
  providerWire,
  anthropicMessagesUrl,
  anthropicDeltaFromJson,
  geminiDeltaFromJson,
  openAiDeltaFromJson,
  openAiErrorFromJson,
  sessionArchiveFromJson,
  extractLinks,
  titleFromPrompt,
  dateBucket,
  bucketTitle,
  relativeTime,
  nextThinking,
  sandboxFileName,
  applyToolDelta,
  finishReasonFromJson,
  toolArg,
  localToolNames,
  WRITE_GRANT_MARK,
  htmlToText,
  splitMarkdown,
  parseTableRows,
  resolveFailoverQueue,
  shouldFailover,
  friendlyModelError,
  toolArgsComplete,
  ToolLoopGuard,
  LOOP_WARN_AT,
  LOOP_STOP_AT,
  MAX_TOOL_ROUNDS,
  loopWarning,
  parseReminderTime,
  nowLine,
  wmoText,
  weatherSummary,
  envPromptBlock,
  expandEnvPlaceholders,
  sessionArchiveJson,
  nextDelta,
  trimHistory,
  usageFromJson,
  fileReadPage,
  formatFileReadOutput,
} from "./localChat.ts";
import { enrichEvent, nowSeconds, replayAfter, dueTasks, dayKey, scheduleSessionTitle, lastRunLabel } from "./bodyRuntime.ts";
import { decide, parseTime, spokenOf } from "./actionRouter.ts";
import * as agentText from "./agentText.ts";
import {
  skipUpstreamModels,
  modelsAuthHeaders,
  modelsListUrl,
  modelIdsFromListJson,
  modelsDevProviderKey,
  idsFromModelsDevJson,
  fallbackModelIds,
  codexCatalogIds,
} from "./providerModels.ts";
import { voiceTemplates, voiceCapabilityLabel, matchVoiceTemplate } from "./voiceTemplates.ts";
import { parseDeviceAuth, classifyDevicePoll, accessTokenFromJson, httpsHost, hostEndsWith } from "./deviceOAuth.ts";
import {
  availableCredentials,
  oauthHint,
  apiKeyHint,
  oauthCallbackPort,
  oauthRedirectUri,
  isOAuthCallbackUrl,
  queryValue,
  codeFromCallback,
  buildOAuthAuthUrl,
  tokenFromExchangeJson,
  oauthNeedsProxy,
  oauthNetworkHint,
  oauthRefreshUrl,
  oauthRefreshUsesForm,
  canRefreshOAuth,
  oauthWebErrorCopy,
  oauthRegionBlocked,
  OPENAI_TOKEN,
  ANTHROPIC_TOKEN,
} from "./browserOAuth.ts";
import {
  usesCodexResponses,
  accountIdFromIdToken,
  responsesInputJson,
  responsesDeltaFromJson,
  responsesErrorFromJson,
  applyResponsesToolDelta,
  combineResponsesIds,
  CODEX_RESPONSES_URL,
  responsesBodyJson,
  TOOL_IMAGE_CAPTION,
} from "./codexResponses.ts";

const ROOT = "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api";

{
  const rows = parseMachines({
    machines: [
      { name: "LeodeMac-mini-2", online: true, server: "leophoneagent" },
      { name: "LeoFold8", online: true, platform: "android", server: "minis", version: "1.0.0-alpha.6" },
      { name: "LeoMate", online: true, platform: "harmony", server: "minis", version: "0.1.0-alpha.1" },
      { name: "" },
    ],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[1].platform, "android");
  assert.equal(rows[2].platform, "harmony");
  assert.equal(isAndroidBody(rows[1]), true);
  assert.equal(isAndroidBody(rows[2]), false);
  assert.equal(isHarmonyBody(rows[2]), true);
  assert.equal(harnessURL(ROOT + "/", "LeoFold8"), ROOT + "/m/LeoFold8");
  assert.equal(sameApiRoot(ROOT + "/", ROOT), true);
  assert.equal(apiRootFromHarnessURL(ROOT + "/m/LeoFold8"), ROOT);
}

{
  const code = encodePair(ROOT + "/", "LeoMate");
  assert.ok(code.startsWith("leoagent-body:v1|"));
  assert.deepEqual(decodePair(code), { apiRoot: ROOT, machine: "LeoMate" });
  assert.equal(decodePair("not-a-code"), null);
  assert.equal(decodePair('leoagent-body:v1|{"apiRoot":"http://insecure","machine":"x"}'), null);
  assert.equal(decodePair(`leoagent-body:v1|{"apiRoot":"${ROOT}","machine":"a/b"}`), null);
  assert.ok(!code.includes("key"));
  const evil = decodePair(`leoagent-body:v1|{"apiRoot":"https://evil.example/relay/api","machine":"LeoMate"}`);
  assert.equal(evil && evil.apiRoot, "https://evil.example/relay/api");

  const v2 = encodePair(ROOT + "/", "LeoMate", "join-short", 1_800_000_000);
  assert.ok(v2.startsWith("leoagent-body:v2|"));
  assert.ok(!v2.includes("key"));
  assert.ok(!v2.includes("secret"));
  const decodedV2 = decodePair(v2);
  assert.equal(decodedV2 && decodedV2.machine, "LeoMate");
  assert.equal(decodedV2 && decodedV2.join, "join-short");
  assert.equal(decodedV2 && decodedV2.exp, 1_800_000_000);
  assert.deepEqual(decodePair(code), { apiRoot: ROOT, machine: "LeoMate" });
}

{
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/relay-t6.json", import.meta.url), "utf8"));
  let last = fixtures.out_of_order.lastSeq;
  const applied = [];
  for (const seq of fixtures.out_of_order.incoming) {
    last = applySeq(last, seq);
    applied.push(last);
  }
  assert.deepEqual(applied, fixtures.out_of_order.applied);

  const replayed = fixtures.replay.events.filter((seq) => seq > fixtures.replay.after);
  assert.deepEqual(replayed, fixtures.replay.replayed);

  const ok = parseResumeEnvelope(fixtures.disconnect.ok);
  assert.equal(ok && ok.status, "ok");
  assert.equal(nextAfter(fixtures.disconnect.lastSeq, ok), fixtures.disconnect.lastSeq);
  const gap = parseResumeEnvelope(fixtures.disconnect.gap);
  assert.equal(gap && gap.status, "gap");
  assert.equal(nextAfter(fixtures.disconnect.lastSeq, gap), fixtures.disconnect.afterGap);
  assert.equal(nextAfter(50, gap), 50, "gap must never rewind lastSeq");
  assert.deepEqual(resumeEnvelope(5, 41), fixtures.disconnect.gap);
  assert.equal(parseResumeEnvelope({ event: "message.delta", seq: 1 }), null);
}

{
  assert.equal(
    agentWsUrl(ROOT),
    "wss://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/agent",
  );
  const frame = registerFrame("LeoMate", "k".repeat(16), "0.1.0-alpha.1");
  assert.equal(frame.type, "register");
  assert.equal(frame.info.platform, "harmony");
  assert.equal(frame.info.server, "minis");
  assert.equal(parseSseData('data: {"seq":1}'), '{"seq":1}');
  assert.equal(parseSseData("keep-alive"), null);
  const httpFrame = parseAgentFrame(JSON.stringify({
    type: "http",
    id: "1",
    method: "GET",
    path: "/health",
  }));
  assert.equal(httpFrame && httpFrame.type, "http");
  assert.equal(httpFrame && httpFrame.path, "/health");
  const resp = respFrame("1", 200, { status: "ok", platform: "harmony" });
  assert.equal(resp.type, "resp");
  assert.equal(resp.status, 200);
}

{
  const kinds = capabilitiesFromJson({
    harnesses: [{ key: "minis", name: "LeoPhoneAgent" }, { name: "no-key" }],
  });
  assert.equal(kinds.length, 1);
  assert.equal(kinds[0].key, "minis");
  const summary = sessionSummaryFromJson({
    session_id: "hs_1",
    harness: "minis",
    name: "LeoPhoneAgent",
    cwd: "~",
    status: "running",
    seq: 3,
    waiting_for_approval: true,
    pending_approvals: [{ approval_id: "ap_1", command: "ls" }],
  });
  assert.equal(summary && summary.id, "hs_1");
  assert.equal(summary && summary.pendingApprovalId, "ap_1");
}

{
  // 打开远程机器时的任务菜单:同一个 Agent、没结束的,最近的在前,最多 5 个;Mac 桌面任务也列出来。
  const protocolSrc = readFileSync(new URL("../app/entry/src/main/ets/net/Protocol.ets", import.meta.url), "utf8");
  const mirror = readFileSync(new URL("./harnessTypes.ts", import.meta.url), "utf8");
  assert.ok(protocolSrc.includes(mirror.slice(mirror.indexOf("export class RemoteTask {"))),
    "harnessTypes.ts 的 parseRemoteTasks 要和 Protocol.ets 一字不差");
  const tasks = parseRemoteTasks({
    sessions: [
      { session_id: "a1", harness: "zcode", status: "idle", title: "整理周报", updated_at: 100 },
      { session_id: "a2", harness: "zcode", status: "cancelled", title: "已停", updated_at: 300 },
      { session_id: "a3", harness: "codex", status: "running", title: "别的 Agent", updated_at: 400 },
      { session_id: "t9", harness: "zcode", status: "available", source: "desktop", title: "桌面上开的一个很长很长很长很长很长的任务标题", updated_at: 200 },
      { session_id: "t8", harness: "zcode", status: "running", source: "desktop", title: "", updated_at: 50 },
      { session_id: "a4", harness: "zcode", status: "waiting_for_approval", title: "等批准", updated_at: 250 },
    ],
  }, "zcode");
  assert.deepEqual(tasks.map((task) => task.id), ["a4", "t9", "a1", "t8"]);
  assert.equal(tasks[0].label, "等批准 · 等你批准");
  assert.equal(tasks[1].label, "桌面上开的一个很长很长很长很长很长的… · Mac 桌面任务");
  assert.equal(tasks[3].label, "任务 t8 · Mac 上在跑");
  // 手机端没有时间戳、按先后排:新的在前;最多 5 个(留一格给「新任务」)。
  const phone = parseRemoteTasks({
    sessions: [1, 2, 3, 4, 5, 6].map((n) => ({ session_id: `hs_000${n}`, harness: "minis", status: "idle" })),
  }, "minis");
  assert.deepEqual(phone.map((task) => task.id), ["hs_0006", "hs_0005", "hs_0004", "hs_0003", "hs_0002"]);
  assert.deepEqual(parseRemoteTasks({}, "minis"), []);
  const fleet = readFileSync(new URL("../app/entry/src/main/ets/panes/FleetPane.ets", import.meta.url), "utf8");
  assert.match(fleet, /client\.tasks\(harness\)/);
  assert.match(fleet, /ChatLaunch\.sessions\.set\(key, tasks\[index - 1\]\.id\)/);
  assert.match(fleet, /ChatLaunch\.sessions\.delete\(key\)/);
  const chat = readFileSync(new URL("../app/entry/src/main/ets/panes/ChatPane.ets", import.meta.url), "utf8");
  // 平板两栏:同一台机器换任务也要重新接上;旧流迟到的回调不能动新流。
  assert.match(chat, /@Prop @Watch\('onLaunch'\) launch/);
  assert.match(chat, /if \(this\.stream === req\) \{\s*this\.onStreamEnd/);
  const home = readFileSync(new URL("../app/entry/src/main/ets/pages/HomePage.ets", import.meta.url), "utf8");
  assert.match(home, /this\.chatLaunch \+= 1/);
}

{
  assert.equal(sanitizeKey("  abcdefghijklmnop%\n"), "abcdefghijklmnop");
  assert.equal(requireHttpsRoot(ROOT + "/"), ROOT);
  assert.throws(() => requireHttpsRoot("http://evil.example/relay/api"));
  assert.throws(() => requireHttpsRoot("https://user:pass@evil.example/relay/api"));
  const next = applyDiscovery(
    [{ name: "LeoFold8", online: true }, { name: "Mac", online: true }],
    [{ name: "Mac", online: true, platform: null, server: "leophoneagent", version: null }],
  );
  assert.equal(next.find((row) => row.name === "LeoFold8")?.online, false);
  assert.equal(next.find((row) => row.name === "Mac")?.online, true);
}

{
  assert.equal(requireProviderRoot("https://api.openai.com/v1/"), "https://api.openai.com/v1");
  assert.equal(requireProviderRoot("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
  assert.equal(requireProviderRoot("http://192.168.1.8:8080/v1"), "http://192.168.1.8:8080/v1");
  assert.throws(() => requireProviderRoot("http://evil.example/v1"));
  assert.throws(() => requireProviderRoot("http://10.evil.com/v1"));
  assert.throws(() => requireProviderRoot("https://user:pass@evil.example/v1"));
  assert.equal(chatCompletionsUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1/chat/completions");
  assert.equal(
    openAiDeltaFromJson({ choices: [{ delta: { content: "pong" } }] }),
    "pong",
  );
  assert.equal(
    openAiDeltaFromJson({ choices: [{ message: { content: "done" } }] }),
    "done",
  );
  assert.equal(openAiErrorFromJson({ error: { message: "bad key" } }), "bad key");
  assert.equal(sessionArchiveFromJson({ title: "x" }), null);
  assert.equal(sessionArchiveFromJson({ messages: [] }), null);
  const archive = sessionArchiveFromJson({
    title: "导入",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", text: "pong" },
      { role: "tool", content: "skip" },
    ],
  });
  assert.equal(archive && archive.title, "导入");
  assert.equal(archive && archive.messages.length, 2);
  assert.deepEqual(extractLinks("看 https://example.com/a 和 http://evil.example/x"), ["https://example.com/a"]);
  assert.deepEqual(extractLinks("局域网 http://192.168.1.8:3000/docs"), ["http://192.168.1.8:3000/docs"]);
  assert.equal(titleFromPrompt("只回复 pong"), "只回复 pong");
  const noon = Date.parse("2026-08-19T12:00:00+08:00");
  assert.equal(dateBucket(noon, noon), "today");
  assert.equal(dateBucket(noon - 86400000, noon), "yesterday");
  assert.equal(dateBucket(noon - 3 * 86400000, noon), "week");
  assert.equal(bucketTitle("today"), "今天");
  assert.equal(relativeTime(noon, noon), "刚刚");
  assert.equal(relativeTime(noon - 5 * 60000, noon), "5 分钟前");
  assert.equal(relativeTime(noon - 3 * 3600000, noon), "3 小时前");
  assert.equal(nextThinking(""), "low");
  assert.equal(nextThinking("high"), "");
  assert.equal(sandboxFileName("/workspace/notes.md"), "notes.md");
  assert.equal(sandboxFileName("var/minis/workspace/a.txt"), "a.txt");
  assert.throws(() => sandboxFileName("../etc/passwd"));
  assert.throws(() => sandboxFileName("a/b"));
  let acc = [];
  acc = applyToolDelta(acc, {
    choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "file_read", arguments: "{\"p" } }] } }],
  });
  acc = applyToolDelta(acc, {
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "ath\":\"n.md\"}" } }] } }],
  });
  assert.equal(acc[0].id, "c1");
  assert.equal(acc[0].name, "file_read");
  assert.equal(acc[0].args, "{\"path\":\"n.md\"}");
  assert.equal(toolArg(acc[0].args, "path"), "n.md");
  assert.equal(finishReasonFromJson({ choices: [{ finish_reason: "tool_calls" }] }), "tool_calls");
  assert.ok(localToolNames().includes("file_write"));
  assert.ok(localToolNames().includes("browser_use"));
  assert.ok(localToolNames().includes("mcp_call"));
  assert.equal(WRITE_GRANT_MARK, "__NEED_WRITE_GRANT__");
  assert.equal(providerWire("anthropic", "https://api.anthropic.com/v1"), "anthropic");
  assert.equal(providerWire("anthropic", "https://openrouter.ai/api/v1"), "openai");
  assert.equal(providerWire("gemini", "https://generativelanguage.googleapis.com/v1beta"), "gemini");
  assert.equal(providerWire("gemini", "https://generativelanguage.googleapis.com/v1beta/openai"), "openai");
  assert.equal(anthropicMessagesUrl("https://api.anthropic.com/v1"), "https://api.anthropic.com/v1/messages");
  assert.equal(anthropicDeltaFromJson({ type: "content_block_delta", delta: { text: "hi" } }), "hi");
  assert.equal(geminiDeltaFromJson({ candidates: [{ content: { parts: [{ text: "pong" }] } }] }), "pong");
  const md = splitMarkdown("# 标题\n```\ncode\nline\n```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n- 项\n2. 第二");
  assert.equal(md[0].kind, "h1");
  assert.equal(md[1].kind, "code");
  assert.equal(md[1].text, "code\nline");
  assert.equal(md[2].kind, "table");
  assert.deepEqual(parseTableRows(md[2].text), [["a", "b"], ["1", "2"]]);
  assert.equal(md[3].kind, "li");
  assert.equal(md[4].kind, "li");
  const queue = resolveFailoverQueue("p1", [
    { id: "p1", label: "OpenAI", model: "gpt-4o", enabled: true },
    { id: "p2", label: "Anthropic", model: "claude-sonnet-5", enabled: true },
  ], ["OpenAI/gpt-4o-mini", "Anthropic/claude-sonnet-5"]);
  assert.equal(queue.length, 2);
  assert.equal(queue[0].model, "gpt-4o-mini");
  assert.equal(queue[1].instanceId, "p2");
  const unlabeled = resolveFailoverQueue("p1", [
    { id: "p1", label: "", model: "gpt-4o", enabled: true, type: "openAI" },
  ], ["openAI/gpt-4o-mini"]);
  assert.equal(unlabeled.length, 1);
  assert.equal(unlabeled[0].model, "gpt-4o-mini");
  assert.equal(htmlToText("<html><script>x()</script><p>你好&nbsp;世界</p></html>"), "你好 世界");
  assert.equal(shouldFailover("http 429"), true);
  assert.equal(shouldFailover("空闲"), false);
  // [prompt, completion] —— 与 LocalProtocol.ets 的 number[] 同形。
  assert.deepEqual(usageFromJson({ usage: { prompt_tokens: 3, completion_tokens: 5 } }), [3, 5]);
  assert.deepEqual(usageFromJson({ usage: { input_tokens: 7, output_tokens: 9 } }), [7, 9]);
  assert.deepEqual(usageFromJson({ usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 4 } }), [2, 4]);
  assert.deepEqual(usageFromJson({}), [0, 0]);
}

{
  const event = JSON.parse(enrichEvent('{"event":"message.delta","delta":"hi"}', 3, "hs_1", 100));
  assert.equal(event.event, "message.delta");
  assert.equal(event.seq, 3);
  assert.equal(event.session_id, "hs_1");
  assert.equal(event.timestamp, 100);

  // 时间戳单位:秒。不带 timestamp 时默认值必须落在秒的量级 ——
  // 传毫秒会大约是这个数的 1000 倍,四端只要有一端算错,UI 上的时间就全错。
  const stamped = JSON.parse(enrichEvent('{"event":"run.completed"}', 1, "hs_2"));
  const seconds = Date.now() / 1000;
  assert.ok(Math.abs(stamped.timestamp - seconds) < 5, `timestamp 应为秒,拿到 ${stamped.timestamp}`);
  assert.ok(stamped.timestamp < Date.now() / 100, "timestamp 落在毫秒量级了");
  assert.ok(Math.abs(nowSeconds() - seconds) < 5);

  // 信封字段压过事件自带的同名键(Mac 的 `{...event, seq, session_id, timestamp}` 同序)。
  const shadowed = JSON.parse(enrichEvent('{"event":"x","seq":99,"session_id":"nope"}', 4, "hs_3", 1));
  assert.equal(shadowed.seq, 4);
  assert.equal(shadowed.session_id, "hs_3");

  // ?after=N 是严格大于 N;seq 从 1 开始,after=0 等于全量重放。
  const log = ['{"seq":1}', '{"seq":2}', '{"seq":3}'];
  assert.deepEqual(replayAfter(log, 0), log);
  assert.deepEqual(replayAfter(log, 2), ['{"seq":3}']);
  assert.deepEqual(replayAfter(log, 3), []);

  const noon = Date.parse("2026-08-20T09:00:20+08:00");
  const justBefore = Date.parse("2026-08-20T08:59:40+08:00");
  const miss = Date.parse("2026-08-20T09:01:20+08:00");
  const rows = [{ rowId: "a", hour: 9, minute: 0, on: true, lastDay: "" }];
  assert.equal(dueTasks(rows, noon, justBefore).length, 1);
  assert.equal(dueTasks(rows, miss, noon).length, 0);
  assert.equal(dueTasks([{ ...rows[0], lastDay: dayKey(noon) }], noon, justBefore).length, 0);
  assert.equal(dueTasks([{ ...rows[0], on: false }], noon, justBefore).length, 0);
}

{
  const auth = parseDeviceAuth({
    device_code: "dev",
    user_code: "WDJB-MJHT",
    verification_uri: "https://www.kimi.com/code/authorize_device",
    verification_uri_complete: "https://www.kimi.com/code/authorize_device?user_code=WDJB-MJHT",
    expires_in: 600,
    interval: 5,
  });
  assert.equal(auth && auth.userCode, "WDJB-MJHT");
  assert.equal(auth && auth.verificationUri, "https://www.kimi.com/code/authorize_device?user_code=WDJB-MJHT");
  const fallback = parseDeviceAuth({
    device_code: "dev",
    user_code: "WDJB-MJHT",
    verification_uri: "https://www.kimi.com/code/authorize_device",
  });
  assert.equal(fallback && fallback.verificationUri, "https://www.kimi.com/code/authorize_device");
  assert.equal(classifyDevicePoll({ error: "authorization_pending" }, false), "pending");
  assert.equal(classifyDevicePoll({ access_token: "tok" }, true), "ok");
  assert.equal(accessTokenFromJson({ access_token: "tok" }), "tok");
  assert.equal(httpsHost("https://auth.x.ai/oauth/token"), "auth.x.ai");
  assert.equal(hostEndsWith("auth.x.ai", "x.ai"), true);
  assert.equal(hostEndsWith("evil.com", "x.ai"), false);
  assert.equal(hostEndsWith("fake.x.ai.evil.com", "x.ai"), false);
}

{
  assert.deepEqual(availableCredentials("kimiCode"), ["oauth", "apiKey"]);
  assert.deepEqual(availableCredentials("xAI"), ["oauth", "apiKey"]);
  assert.deepEqual(availableCredentials("openAI"), ["apiKey", "oauth"]);
  assert.deepEqual(availableCredentials("anthropic"), ["apiKey", "oauth"]);
  assert.deepEqual(availableCredentials("openRouter"), ["apiKey", "oauth"]);
  assert.deepEqual(availableCredentials("gemini"), ["apiKey"]);
  assert.deepEqual(availableCredentials("custom"), ["apiKey"]);
  assert.ok(oauthHint("kimiCode").includes("Kimi"));
  assert.ok(apiKeyHint("gemini").includes("Gemini"));
  assert.equal(oauthCallbackPort("openAI"), 1455);
  assert.equal(oauthRedirectUri("anthropic"), "http://localhost:54545/callback");
  assert.equal(oauthRedirectUri("openRouter"), "http://localhost:3000/callback");
  assert.equal(isOAuthCallbackUrl("http://localhost:3000/callback?code=abc&state=s1", "openRouter"), true);
  assert.equal(isOAuthCallbackUrl("http://127.0.0.1:1455/auth/callback?code=abc", "openAI"), true);
  assert.equal(isOAuthCallbackUrl("https://evil.com/callback?code=abc", "openRouter"), false);
  assert.equal(queryValue("http://localhost:3000/callback?code=ab%2Fc&state=s1", "code"), "ab/c");
  assert.equal(codeFromCallback("http://localhost:3000/callback?code=tok&state=s1", "s1"), "tok");
  assert.throws(() => codeFromCallback("http://localhost:3000/callback?code=tok&state=no", "s1"));
  const url = buildOAuthAuthUrl("openRouter", "chal", "st");
  assert.ok(url.startsWith("https://openrouter.ai/auth?"));
  assert.ok(url.includes("code_challenge=chal"));
  assert.ok(url.includes("callback_url="));
  assert.equal(tokenFromExchangeJson("openRouter", { key: "sk-or-1" }), "sk-or-1");
  assert.equal(tokenFromExchangeJson("anthropic", { access_token: "sk-ant-oat" }), "sk-ant-oat");
}

{
  assert.equal(usesCodexResponses("openAI", "oauth", "https://api.openai.com/v1"), true);
  assert.equal(usesCodexResponses("openAI", "apiKey", "https://api.openai.com/v1"), false);
  assert.equal(usesCodexResponses("openAI", "oauth", "https://proxy.example/v1"), false);
  const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: "acc_1" })).toString("base64url");
  assert.equal(accountIdFromIdToken(`aaa.${payload}.sig`), "acc_1");
  assert.equal(CODEX_RESPONSES_URL, "https://chatgpt.com/backend-api/codex/responses");
  const input = JSON.parse(responsesInputJson([
    { role: "user", content: "hi" },
    { role: "assistant", content: "", calls: [{ id: "call_1|fc_1", name: "file_list", args: "{}" }] },
    { role: "tool", content: "ok", toolCallId: "call_1|fc_1" },
  ]));
  assert.equal(input[0].role, "user");
  assert.equal(input[1].type, "function_call");
  assert.equal(input[1].call_id, "call_1");
  assert.equal(input[2].type, "function_call_output");
  assert.equal(responsesDeltaFromJson({ type: "response.output_text.delta", delta: "yo" }), "yo");
  assert.equal(responsesErrorFromJson({ type: "response.failed", response: { error: { message: "boom" } } }), "boom");
  let calls = applyResponsesToolDelta([], {
    type: "response.output_item.added",
    item: { type: "function_call", id: "fc_9", call_id: "call_9", name: "file_read" },
  });
  assert.equal(calls[0].id, combineResponsesIds("call_9", "fc_9"));
  calls = applyResponsesToolDelta(calls, { type: "response.function_call_arguments.delta", item_id: "fc_9", delta: "{\"p" });
  calls = applyResponsesToolDelta(calls, {
    type: "response.output_item.done",
    item: { type: "function_call", id: "fc_9", arguments: "{\"path\":\"a\"}" },
  });
  assert.equal(calls[0].args, "{\"path\":\"a\"}");
}

{
  assert.equal(oauthNeedsProxy("openAI"), true);
  assert.equal(oauthNeedsProxy("kimiCode"), false);
  assert.ok(oauthNetworkHint("openAI").includes("auth.openai.com"));
  assert.equal(oauthRefreshUrl("openAI"), OPENAI_TOKEN);
  assert.equal(oauthRefreshUrl("anthropic"), ANTHROPIC_TOKEN);
  assert.equal(oauthRefreshUsesForm("kimiCode"), true);
  assert.equal(oauthRefreshUsesForm("openAI"), false);
  assert.equal(canRefreshOAuth("anthropic"), true);
  assert.equal(canRefreshOAuth("openRouter"), false);
  assert.ok(oauthWebErrorCopy("3", "timeout").includes("页面打不开"));
  assert.equal(oauthRegionBlocked("HTTP 403", "unsupported_country_region_territory"), true);
  assert.ok(oauthWebErrorCopy("HTTP 403", "unsupported_country", "openAI").includes("当前地区不可用"));
  assert.ok(!oauthWebErrorCopy("HTTP 403", "unsupported_country", "openAI").includes("{"));
}

{
  assert.equal(skipUpstreamModels("openAI", "oauth"), true);
  assert.equal(skipUpstreamModels("openAI", "apiKey"), false);
  assert.equal(modelsAuthHeaders("gemini", "gk")["x-goog-api-key"], "gk");
  assert.equal(modelsAuthHeaders("anthropic", "ak")["x-api-key"], "ak");
  assert.equal(modelsAuthHeaders("anthropic", "ak")["anthropic-version"], "2023-06-01");
  assert.ok(modelsAuthHeaders("openAI", "sk").Authorization.includes("sk"));
  assert.ok(modelsListUrl("https://generativelanguage.googleapis.com/v1beta", "gemini", "gk").includes("key=gk"));
  assert.equal(modelsListUrl("https://api.openai.com/v1", "openAI", "sk"), "https://api.openai.com/v1/models");
  assert.deepEqual(modelIdsFromListJson({ data: [{ id: "gpt-4o" }, { id: "" }] }), ["gpt-4o"]);
  assert.deepEqual(modelIdsFromListJson({ models: [{ name: "models/gemini-2.5-flash" }] }), ["gemini-2.5-flash"]);
  assert.equal(modelsDevProviderKey("gemini"), "google");
  assert.deepEqual(idsFromModelsDevJson({ openai: { models: { "gpt-4o": {}, "o3": {} } } }, "openai"), ["gpt-4o", "o3"]);
  assert.deepEqual(fallbackModelIds(["a"], []), ["a"]);
  assert.deepEqual(fallbackModelIds(["a"], ["b"]), ["b"]);
}

{
  assert.equal(scheduleSessionTitle("早报"), "定时·早报");
  assert.ok(lastRunLabel(0, "", "http 401").startsWith("失败"));
  assert.equal(lastRunLabel(0, "", ""), "还没跑过");
  assert.ok(lastRunLabel(Date.now() - 1000, "今天晴", "").includes("刚刚"));
}

{
  const rows = voiceTemplates();
  assert.ok(rows.length >= 7);
  assert.equal(voiceCapabilityLabel("TTS"), "语音合成");
  const mimo = matchVoiceTemplate("https://api.xiaomimimo.com/v1");
  assert.equal(mimo && mimo.id, "mimo");
}

// ---------------------------------------------------------------------------
// 跨端契约:直接读四端真正上线的源码,不读这个目录里的镜像。
//
// 为什么不用镜像:`src/harmony/protocol/*.ts` 编译不进 HAP —— ArkTS 那边
// (`app/entry/src/main/ets/`)是人手维护的另一份拷贝,ets 里一行 import 都没有
// 指向这里。镜像测得再绿,线上的那份照样可以漂走(`usageFromJson` 的对象 vs 数组
// 就是这么漂的)。所以下面这些断言直接读源文件文本 —— 只要哪一端改了线上常量而
// 没同步另外三端,这条测试就红。
// ---------------------------------------------------------------------------
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const harmonyRouter = src("../app/entry/src/main/ets/local/HarmonyMinisRouter.ets");
const harmonyCodec = src("../app/entry/src/main/ets/net/OutboundCodec.ets");
const harmonyOutbound = src("../app/entry/src/main/ets/net/OutboundClient.ets");
const androidRouter = src("../../android/app/src/main/java/com/leoyuan/leophoneagent/relay/MinisHarnessRouter.kt");
// Mac 端是 Leo Link 桥接(src/mac/leophone);旧的 src/mac/leocodebox 只作回退,不再代表线上协议。
const macRoutes = src("../../mac/leophone/packages/desktop/src/host/leo/link/bridge.ts");
const macSession = src("../../mac/leophone/packages/desktop/src/host/leo/link/session.ts");
const macJournal = src("../../mac/leophone/packages/desktop/src/host/leo/link/journal.ts");

/** 把 ArkTS 的模板串还原成能 JSON.parse 的形状:`${JSON.stringify(x)}` → "<x>"。 */
function wireShape(source, startsWith) {
  const at = source.indexOf("`" + startsWith);
  assert.ok(at >= 0, `找不到以 ${startsWith} 开头的出线模板`);
  const end = source.indexOf("`", at + 1);
  const raw = source.slice(at + 1, end);
  return JSON.parse(raw.replace(/\$\{[^}]*\}/g, '"<hole>"'));
}

{
  // --- 协议版本:四端同一个号,且不是 App 版本 ---
  const harmonyVersion = /PROTOCOL_VERSION:\s*string\s*=\s*'([^']+)'/.exec(harmonyRouter);
  const androidVersion = /const val PROTOCOL_VERSION = "([^"]+)"/.exec(androidRouter);
  const macVersion = /const VERSION = ["']([^"']+)["']/.exec(macRoutes);
  assert.ok(harmonyVersion && androidVersion && macVersion, "三端都要有协议版本常量");
  assert.equal(harmonyVersion[1], androidVersion[1]);
  assert.equal(harmonyVersion[1], macVersion[1]);

  const health = wireShape(harmonyRouter, '{"status":"ok"');
  assert.equal(health.status, "ok");
  assert.equal(health.platform, "harmony");
  assert.equal(health.server, "minis");
  assert.ok("app_version" in health, "/health 要带 app_version");
  // 关键:哪个常量填进哪个字段。之前 version 和 app_version 填的是同一个
  // ReleaseCatalog.currentVersion,version 就成了 0.3.0-alpha.x,跟另外三端对不上。
  assert.ok(/"version":\$\{JSON\.stringify\(PROTOCOL_VERSION\)\}/.test(harmonyRouter),
    "version 必须填协议版本常量,不能填 App 版本");
  assert.ok(/"app_version":\$\{JSON\.stringify\(ReleaseCatalog\.currentVersion\)\}/.test(harmonyRouter),
    "app_version 才是 App 版本");
  assert.ok(!/"version":\$\{JSON\.stringify\(ReleaseCatalog/.test(harmonyRouter),
    "version 字段里不能出现 ReleaseCatalog");

  const caps = wireShape(harmonyRouter, '{"object":"leoagent.capabilities"');
  assert.equal(caps.platform, "harmony");
  assert.equal(caps.server, "minis");
  assert.equal(caps.version, health.version, "capabilities 与 health 的 version 同源");
  assert.deepEqual(caps.harnesses, [{ key: "minis", name: "LeoPhoneAgent" }]);

  // features 的键要跟 Mac 一字不差(值可以不同,键不能少)。
  const macFeatures = /features:\s*\{([\s\S]*?)\n\s*\}/.exec(macRoutes);
  assert.ok(macFeatures, "读不到 Mac 的 features");
  const macKeys = [...macFeatures[1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(caps.features).sort(), macKeys);
  // 鸿蒙身体没有审批链路,必须显式说不支持 —— iOS 的 `features[x] == true` 读法
  // 里省略等于 false,但别的消费者未必这么读。
  assert.equal(caps.features.approval_events, false);
  assert.equal(caps.features.harness_sessions, true);
  assert.equal(caps.features.resumable_events, true);
}

{
  // --- 关键事件外推:名单要与 Mac 的 PUSHABLE_EVENTS 一致 ---
  const harmonyPush = /const PUSH_EVENTS: string\[\] = \[([^\]]*)\]/.exec(harmonyRouter);
  assert.ok(harmonyPush, "鸿蒙缺 PUSH_EVENTS");
  const harmonyNames = [...harmonyPush[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  const macPush = /const PUSHABLE(?:_EVENTS)? = new Set\(\[([\s\S]*?)\]\)/.exec(macSession);
  assert.ok(macPush, "读不到 Mac 的 PUSHABLE");
  const macNames = [...macPush[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]).sort();
  assert.deepEqual(harmonyNames, macNames);

  // 名单要真的接上出线口,否则等于没推(eventJson 曾经定义了却没人调用)。
  assert.ok(/onPush/.test(harmonyRouter), "router 要有 onPush 出口");
  assert.ok(/harmonyRouter\.onPush\s*=/.test(harmonyOutbound), "OutboundClient 要接上 onPush");
  assert.ok(/eventJson\(/.test(harmonyOutbound), "外推要用 eventJson 组帧");
}

{
  // --- 事件信封:秒,不是毫秒 ---
  assert.ok(/obj\['timestamp'\] = Date\.now\(\) \/ 1000;/.test(harmonyRouter),
    "鸿蒙的事件 timestamp 必须是 Date.now()/1000(秒)");
  assert.ok(/timestamp: Date\.now\(\) \/ 1000/.test(macSession), "Mac 也是秒");
  assert.ok(/System\.currentTimeMillis\(\) \/ 1000\.0/.test(androidRouter), "Android 也是秒");

  // --- run.failed 两个字段都带 ---
  // 协议原文(Mac harness-dialects/harness-session)发 `error`;Android 发 `message`;
  // iOS 两个都收(error 优先)。两个都带才是四端都不会漏的写法。
  const failedTpl = /private static runFailed\(message: string\): string \{[\s\S]*?return `([^`]*)`/.exec(harmonyRouter);
  assert.ok(failedTpl, "找不到 runFailed 模板");
  const failed = JSON.parse(failedTpl[1].replace(/\$\{[^}]*\}/g, '"boom"'));
  assert.equal(failed.event, "run.failed");
  assert.equal(failed.error, "boom", "run.failed 要带 error(Mac 读这个)");
  assert.equal(failed.message, "boom", "run.failed 要带 message(Android/本端读这个)");

  // --- 补齐语义:严格大于 ---
  assert.ok(/if \(i \+ 1 > after\)/.test(harmonyRouter), "replay 必须是严格大于 after");
  assert.ok(/\.seq\) > after\b/.test(macJournal), "Mac 也是严格大于");

  // --- stream_open 的每一条出路都要收尾 ---
  // 中继挂在 stream 队列上等 stream_data/stream_close,`resp` 帧会被丢掉。
  // 非流分支(会话不存在)只发 resp 不发 stream_close,手机的 SSE 会空转到超时。
  const openStream = /private openStream\([\s\S]*?\n  \}/.exec(harmonyOutbound);
  assert.ok(openStream, "找不到 openStream");
  const nonStream = openStream[0].slice(0, openStream[0].indexOf("harmonyRouter.replay"));
  assert.ok(/streamCloseJson\(id\)/.test(nonStream),
    "openStream 的非流分支必须补 stream_close,否则手机侧 SSE 永久挂起");
}

{
  // --- register 帧:身体类型不能自称 android ---
  assert.ok(/"platform":"harmony"/.test(harmonyCodec), "register 的 platform 必须是 harmony");
  assert.ok(/"server":"minis"/.test(harmonyCodec), "register 的 server 必须是 minis");
  const frame = registerFrame("LeoHarmony", "k".repeat(24), "0.3.0-alpha.14");
  assert.equal(frame.info.platform, "harmony");
  assert.equal(frame.info.server, "minis");
  assert.ok(!JSON.stringify(frame.info).includes("k".repeat(24)), "钥匙不能进 info");

  // isAndroidBody 必须先把 harmony 摘出去 —— 否则 platform=harmony + server=minis
  // 会被认成安卓身体(iOS 和 Android 现在就是这样,见报告)。
  const harmonyMachine = { name: "LeoHarmony", online: true, platform: "harmony", server: "minis", version: "1" };
  assert.equal(isHarmonyBody(harmonyMachine), true);
  assert.equal(isAndroidBody(harmonyMachine), false);
  assert.equal(isAndroidBody({ name: "Fold8", online: true, platform: "android", server: "minis", version: "1" }), true);
  assert.equal(isAndroidBody({ name: "Mac", online: true, platform: "leoagent", server: "leophoneagent", version: "1" }), false);
}

{
  const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
  const head = fileReadPage(lines, 1, 5, 15000, "head");
  assert.equal(head.showStart, 1);
  assert.equal(head.showEnd, 5);
  assert.equal(head.nextOffset, 6);
  assert.equal(head.content, "L1\nL2\nL3\nL4\nL5");
  const last = fileReadPage(lines, 18, 10, 15000, "head");
  assert.equal(last.nextOffset, null);
  const clipped = fileReadPage(["aaaa", "bbbb", "cccc", "dddd"], 1, null, 9, "head");
  assert.equal(clipped.content, "aaaa\nbbbb");
  assert.equal(clipped.nextOffset, 3);
  assert.equal(clipped.truncated, true);
  const tail = fileReadPage(lines, 1, 3, 15000, "tail");
  assert.equal(tail.showStart, 18);
  assert.equal(tail.nextOffset, null);
  const formatted = formatFileReadOutput("/tmp/x", 4, { showStart: 1, showEnd: 2, totalLines: 10, content: "a\nb", truncated: false, nextOffset: 3 });
  assert.match(formatted, /next_offset: 3/);
  assert.match(formatted, /showing 1-2 of 10/);
}

{
  const hit = decide("把这张图存进相册", 1);
  assert.equal(hit.path, "native");
  assert.equal(hit.kind, "savePhoto");
  assert.equal(decide("把这张图存进相册", 0).path, "agent");

  const alarm = decide("定个明早 8 点闹钟", 0);
  assert.equal(alarm.kind, "setAlarm");
  assert.equal(alarm.hour, 8);
  assert.equal(alarm.minute, 0);
  assert.equal(alarm.tomorrow, true);
  assert.match(spokenOf(alarm), /08:00/);

  const colon = decide("set alarm for 7:30", 0);
  assert.equal(colon.hour, 7);
  assert.equal(colon.minute, 30);

  const cal = decide("把明早 9:00 开会加到日历", 0);
  assert.equal(cal.kind, "createCalendar");
  assert.equal(cal.hour, 9);
  assert.equal(cal.tomorrow, true);

  const enPhoto = decide("Save this photo to the album", 1);
  assert.equal(enPhoto.kind, "savePhoto");
  const enCal = decide("add to calendar tomorrow 10:00 standup", 0);
  assert.equal(enCal.kind, "createCalendar");
  assert.equal(enCal.hour, 10);
  const zhCal = decide("create calendar event 明天 15:00 复盘", 0);
  assert.equal(zhCal.kind, "createCalendar");
  assert.equal(zhCal.hour, 15);
  const dawn = decide("明早 6:30 闹钟", 0);
  assert.equal(dawn.kind, "setAlarm");
  assert.equal(dawn.hour, 6);
  assert.equal(dawn.minute, 30);
  const tonight = decide("定个今晚 22:00 闹钟 吃药", 0);
  assert.equal(tonight.kind, "setAlarm");
  assert.equal(tonight.hour, 22);
  assert.equal(tonight.tomorrow, false);

  assert.equal(decide("帮我看看这张图", 1).path, "agent");
  assert.equal(decide("设个闹钟", 0).path, "agent");
  assert.deepEqual(parseTime("没有时间"), []);

  const on = decide("打开手电筒", 0);
  assert.equal(on.kind, "toggleFlashlight");
  assert.equal(on.label, "on");
  assert.match(spokenOf(on), /打开/);
  const off = decide("turn off flashlight", 0);
  assert.equal(off.label, "off");
  const todo = decide("记个待办 买牛奶", 0);
  assert.equal(todo.kind, "createTodo");
  assert.equal(todo.label, "买牛奶");
  const enTodo = decide("remind me to call mom", 0);
  assert.equal(enTodo.kind, "createTodo");
  assert.equal(enTodo.label, "call mom");
  assert.equal(decide("手电筒坏了怎么办", 0).path, "agent");
  // 和 iOS、安卓一样:「帮我记一下」是记待办。
  assert.equal(decide("帮我记一下今天的会", 0).kind, "createTodo");

  // --- 0.3.0-alpha.18:和安卓 ActionRouter 对齐 ---
  const sat = new Date(2026, 8, 26, 10, 0); // 周六
  const later = decide("提醒我后天下午3点交报告", 0, sat);
  assert.equal(later.path, "native");
  assert.equal(later.kind, "createTodo");
  assert.equal(later.dayOffset, 2);
  assert.equal(later.hour, 15);
  assert.equal(later.label, "交报告");
  assert.match(spokenOf(later), /后天 15:00 提醒你/);
  assert.equal(decide("3天后 9:00 加到日历 复诊", 0, sat).dayOffset, 3);
  assert.equal(decide("10月1日 8:00 加到日历 出发", 0, sat).dayOffset, 5);
  assert.equal(decide("9月1日 8:00 加到日历 体检", 0, sat).dayOffset, 340, "过了的日期算明年");
  assert.equal(decide("周一 9:00 加到日历 周会", 0, sat).dayOffset, 2);
  assert.equal(decide("下周一 9:00 加到日历 周会", 0, sat).dayOffset, 9);
  assert.equal(decide("周六 9:00 加到日历 爬山", 0, sat).dayOffset, 0);

  // 缺信息只追问缺的那一项,不交给模型去猜。
  const noTime = decide("把项目评审加到日历", 0, sat);
  assert.equal(noTime.path, "clarify");
  assert.deepEqual(noTime.missing, ["开始时间"]);
  assert.match(spokenOf(noTime), /还需要：开始时间/);
  const noTitle = decide("提醒我", 0, sat);
  assert.equal(noTitle.path, "clarify");
  assert.deepEqual(noTitle.missing, ["要提醒的事情"]);

  // 出行记录
  const trip = decide("帮我记录明天 8:30 去杭州的高铁 G7311 座位 05车12F", 0, sat);
  assert.equal(trip.kind, "createTravel");
  assert.equal(trip.path, "native");
  assert.equal(trip.location, "杭州");
  assert.match(trip.notes, /车次：G7311/);
  assert.match(trip.notes, /座位：05车12F/);
  const tripNoTime = decide("记一下去上海的航班", 0, sat);
  assert.equal(tripNoTime.path, "clarify");
  assert.ok(tripNoTime.missing.includes("开车时间"));

  // 剪贴板和设备信息
  const copy = decide("把 SN-2026-0926 复制到剪贴板", 0, sat);
  assert.equal(copy.kind, "writeClipboard");
  assert.equal(copy.label, "SN-2026-0926");
  assert.equal(decide("Copy Hello World to the clipboard", 0).label, "Hello World");
  assert.equal(decide("看看设备信息", 0).kind, "deviceInfo");
  assert.equal(decide("读取剪贴板", 0).path, "agent", "鸿蒙读剪贴板要受限权限,交给模型");

  // 执行凭证:和安卓同一个格式
  const receiptSrc = readFileSync(new URL("../app/entry/src/main/ets/local/ActionRouter.ets", import.meta.url), "utf8");
  assert.match(receiptSrc, /执行凭证\\n- 路径：/);
  // 镜像必须原样包含 ArkTS 源码,两边不会各改各的。
  const mirror = readFileSync(new URL("./actionRouter.ts", import.meta.url), "utf8");
  assert.ok(mirror.includes(receiptSrc), "protocol/actionRouter.ts 要和 ActionRouter.ets 一字不差");
}

{
  // --- 0.3.0-alpha.18 对齐:本机 Agent ---
  const etsSrc = (rel) => readFileSync(new URL(`../app/entry/src/main/ets/${rel}`, import.meta.url), "utf8");
  // 一轮的流程从聊天页搬进了 ChatRun(离开页面接着跑),审批栏还在页面上:两处一起查。
  const chatPane = etsSrc("panes/LocalChatPane.ets") + etsSrc("local/ChatRun.ets");
  const tools = etsSrc("local/LocalTools.ets");
  const client = etsSrc("local/OpenAICompatClient.ets");
  const gate = etsSrc("local/SensitiveToolGate.ets");
  const protocolEts = etsSrc("local/LocalProtocol.ets");

  // Anthropic 流中途 overloaded:要当成错误(还能换一家),不能把半截回答当完整回答。
  const overloaded = responsesErrorFromJson({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  assert.match(overloaded, /overloaded/);
  assert.ok(shouldFailover(overloaded));
  assert.equal(responsesErrorFromJson({ type: "error", message: "boom" }), "boom", "Codex 顶层 message 照旧");
  assert.ok(shouldFailover("stream ended early"));
  assert.ok(/err\['type'\]/.test(protocolEts), "LocalProtocol.ets 也要读 Anthropic 的 error 对象");
  assert.ok(/this\.mode === 'anthropic' && !ended/.test(client), "没收到 message_delta/message_stop 的 Anthropic 流算中途断了");
  assert.match(friendlyModelError("unauthorized"), /AI 服务商/);
  assert.equal(friendlyModelError("没有这个模型"), "没有这个模型");

  // 半截参数的工具调用:不补全、不执行。
  assert.equal(toolArgsComplete('{"path":"a.md","content":"hal'), false);
  assert.equal(toolArgsComplete('{"path":"a.md"}'), true);
  assert.equal(toolArgsComplete(""), true);
  const runBody = tools.slice(tools.indexOf("static async run("));
  assert.ok(runBody.indexOf("toolArgsComplete(args)") >= 0 &&
    runBody.indexOf("toolArgsComplete(args)") < runBody.indexOf("name === 'file_list'"),
    "LocalTools.run 要在执行任何工具之前检查参数完整");

  // 审批:和 iOS 同样的选项,永远有全自动。
  for (const label of ["允许一次", "本次会话允许", "拒绝", "拒绝并停止任务"]) {
    assert.ok(chatPane.includes(`'${label}'`), `本机审批栏要有「${label}」`);
  }
  assert.ok(!chatPane.includes("允许写这次"), "旧的单按钮文案要去掉");
  assert.ok(/static fullAuto: boolean/.test(gate) && /'全自动'/.test(gate), "要有全自动");
  assert.ok(/cmd === '\/auto'/.test(chatPane), "/auto 切换全自动");
  assert.match(gate, /用户拒绝了「写文件」/, "拒绝回执和 iOS 同一句话");

  // 停止真的停:剩下的工具和下一轮都要看这一轮还算不算数(每一轮带自己的 gen)。
  const runTools = chatPane.slice(chatPane.indexOf("private async runTools("));
  assert.ok(/if \(gen !== this\.runGen\) \{\s*return;/.test(runTools.slice(0, 400)), "runTools 每个工具前检查");
  // 换对话、离开页面不再作废正在跑的一轮:页面只是不看它了。
  const sessionChange = chatPane.slice(chatPane.indexOf("onSessionChange()"), chatPane.indexOf("onSessionChange()") + 400);
  assert.ok(/this\.detach\(\)/.test(sessionChange) && !/cancelRun|\.stop\(\)/.test(sessionChange), "换对话时那一轮接着跑");
  const leave = chatPane.slice(chatPane.indexOf("aboutToDisappear()"), chatPane.indexOf("aboutToDisappear()") + 300);
  assert.ok(/this\.detach\(\)/.test(leave) && !/runGen|cancelRun|\.stop\(\)/.test(leave), "离开页面时那一轮接着跑");
  // 工具执行前先存这一步。
  assert.ok(/saveToolRound\(turn\.text, calls\)\.then/.test(chatPane), "工具执行前先存模型这一步");
}

{
  // --- 0.3.0-alpha.18 对齐:轮数、重复检测、手机工具 ---
  const etsSrc = (rel) => readFileSync(new URL(`../app/entry/src/main/ets/${rel}`, import.meta.url), "utf8");
  const protocolEts = etsSrc("local/LocalProtocol.ets");
  const phone = etsSrc("local/PhoneTools.ets");
  const tools = etsSrc("local/LocalTools.ets");
  const fast = etsSrc("local/FastLocalActions.ets");
  const moduleJson = readFileSync(new URL("../app/entry/src/main/module.json5", import.meta.url), "utf8");

  assert.equal(MAX_TOOL_ROUNDS, 50);
  assert.ok(/MAX_TOOL_ROUNDS: number = 50/.test(protocolEts), "ETS 与 TS 同一个上限");
  const guard = new ToolLoopGuard();
  assert.equal(guard.note("web_fetch", '{"url":"a"}'), 1);
  assert.equal(guard.note("web_fetch", '{"url":"b"}'), 1, "参数不同不算重复");
  assert.equal(guard.note("web_fetch", '{"url":"a"}'), 2);
  assert.ok(LOOP_WARN_AT < LOOP_STOP_AT);
  assert.match(loopWarning("web_fetch", 3), /第 3 次/);

  // 手机工具:工具清单(ETS)、TS 镜像、PhoneTools.NAMES 三处一致,分发也接上了。
  const schemaNames = [...protocolEts.slice(protocolEts.indexOf("export function localToolSchemaJson"),
    protocolEts.indexOf("export function anthropicToolSchemaJson")).matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...schemaNames].sort(), [...localToolNames()].sort(), "ETS 工具清单与 TS 镜像一致");
  const phoneNames = [...phone.match(/NAMES: string\[\] = \[([\s\S]*?)\]/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  for (const name of phoneNames) {
    assert.ok(schemaNames.includes(name), `${name} 要在工具清单里`);
  }
  assert.ok(/PhoneTools\.NAMES\.indexOf\(name\) >= 0/.test(tools), "LocalTools.run 要把手机工具交给 PhoneTools");
  assert.ok(/ohos\.permission\.APPROXIMATELY_LOCATION/.test(moduleJson) && /ohos\.permission\.LOCATION"/.test(moduleJson),
    "定位要在 module.json5 里声明");
  // 待办发不出去不能报成功。
  const todo = fast.slice(fast.indexOf("static async postNotice("), fast.indexOf("static async addAlarm("));
  assert.ok(/catch \(_err\) \{\s*return false;/.test(todo), "通知失败要如实返回 false");

  // 提醒时间:只收具体的将来时间。
  const now = new Date(2026, 8, 26, 10, 0).getTime();
  assert.deepEqual(parseReminderTime("2026-09-27 09:30", now), { year: 2026, month: 9, day: 27, hour: 9, minute: 30 });
  assert.deepEqual(parseReminderTime("2026-09-27T09:30:00", now), { year: 2026, month: 9, day: 27, hour: 9, minute: 30 });
  assert.equal(parseReminderTime("2026-09-25 09:30", now), null, "过去的时间不收");
  assert.equal(parseReminderTime("明天九点", now), null);
  assert.equal(parseReminderTime("2026-13-01 09:30", now), null);
  assert.match(nowLine(now), /2026-09-26 周六 10:00/);

  // 天气:WMO 代码和摘要,和安卓同一套代码表。
  assert.equal(wmoText(0), "晴");
  assert.equal(wmoText(63), "中雨");
  assert.equal(wmoText(95), "雷阵雨");
  const summary = weatherSummary({
    current: { temperature_2m: 22.6, apparent_temperature: 23.1, relative_humidity_2m: 61, weather_code: 2, wind_speed_10m: 11.4 },
    daily: { time: ["2026-09-26", "2026-09-27", "2026-09-28"], weather_code: [2, 61, 0],
      temperature_2m_max: [27, 24, 26], temperature_2m_min: [18, 17, 16], precipitation_probability_max: [10, 80, 0] },
  }, "杭州");
  assert.match(summary, /^杭州 · 现在 23°C\(体感 23°C\),局部多云,湿度 61%,风 11 km\/h/);
  assert.match(summary, /明天\(2026-09-27\) 小雨,17–24°C,降水概率 80%/);
  assert.equal(weatherSummary({}, "x"), "天气服务没有返回数据");
}

{
  // --- 0.3.0-alpha.18 对齐:环境变量、导出、ChatGPT 目录、启动、服务商清理、滚动 ---
  const etsSrc = (rel) => readFileSync(new URL(`../app/entry/src/main/ets/${rel}`, import.meta.url), "utf8");

  // 环境变量:只给模型名字,执行时才换值。
  const block = envPromptBlock(["GITHUB_TOKEN", "HOME_WIFI"]);
  assert.match(block, /GITHUB_TOKEN、HOME_WIFI/);
  assert.ok(!/=/.test(block.replace(/\$\$名字/, "")), "系统提示里不出现 名字=值");
  const values = new Map([["GITHUB_TOKEN", 'ab"c'], ["X", "1"]]);
  assert.equal(expandEnvPlaceholders('{"url":"https://x/?t=$$GITHUB_TOKEN&u=$$NOPE"}', values),
    '{"url":"https://x/?t=ab\\"c&u=$$NOPE"}', "值按 JSON 转义,不认识的名字原样留着");
  assert.ok(!/\$\{this\.rows\[i\]\.value\}/.test(etsSrc("store/EnvStore.ets")), "EnvStore 不再把值写进提示");
  assert.ok(/envStore\.expand\(raw\)/.test(etsSrc("local/LocalTools.ets")), "工具执行前替换 $$名字");

  // 导出的档案能原样导回来。
  const exported = sessionArchiveJson("周末计划", [
    { role: "user", text: "周末去哪" }, { role: "assistant", text: "去西湖" }, { role: "tool", text: "x" },
  ]);
  const back = sessionArchiveFromJson(JSON.parse(exported));
  assert.equal(back.title, "周末计划");
  assert.deepEqual(back.messages.map((m) => [m.role, m.text]), [["user", "周末去哪"], ["assistant", "去西湖"]]);
  assert.ok(/'导出对话'/.test(etsSrc("panes/LocalAgentPane.ets")), "对话菜单里有导出");

  // ChatGPT 登录的模型目录:只列 visibility=list,按 priority。
  assert.deepEqual(codexCatalogIds({ models: [
    { slug: "gpt-5.5", priority: 3 }, { slug: "gpt-6-sol", priority: 1 },
    { slug: "hidden", visibility: "hide", priority: 0 }, { slug: "gpt-6-astra", priority: 2 },
  ] }), ["gpt-6-sol", "gpt-6-astra", "gpt-5.5"]);
  assert.deepEqual(codexCatalogIds({}), []);
  assert.ok(/'gpt-6-astra'/.test(etsSrc("local/ProviderCatalog.ets")) && /'grok-4\.6'/.test(etsSrc("local/ProviderCatalog.ets")),
    "内置目录有 GPT-6 和 Grok 4.6");

  // 启动「自动」生效;删服务商清模型组;流式不硬拽到底。
  assert.ok(/themeStore\.launch === 'auto'/.test(etsSrc("panes/LocalAgentPane.ets")), "「自动」要生效");
  const remove = etsSrc("store/ProviderStore.ets");
  assert.ok(/startsWith\(`\$\{tag\}\/`\)/.test(remove.slice(remove.indexOf("async remove("), remove.indexOf("async setActive("))),
    "删服务商时清掉它在模型组里的条目");
  assert.ok(/!force && !this\.nearBottom/.test(etsSrc("panes/LocalChatPane.ets")), "不在底部时不跟随");
}

{
  // 发给模型的历史有上限:从最早的整轮丢起,最新一句总会发,图片只发最近两张。
  const turn = (role, content, imageB64 = "") => ({ role, content, imageB64, imageMime: "image/jpeg" });
  const ten = (tag) => tag.padEnd(10, ".");
  const short = [turn("user", "你好"), turn("assistant", "在")];
  assert.deepEqual(trimHistory(short, 60000).map((row) => row.content), ["你好", "在"]);
  const five = [turn("user", ten("u1")), turn("assistant", ten("a1")), turn("user", ten("u2")),
    turn("assistant", ten("a2")), turn("user", ten("u3"))];
  const cut = trimHistory(five, 35);
  assert.deepEqual(cut.map((row) => row.role), ["user", "assistant", "user"]);
  assert.ok(cut[0].content.startsWith("(更早的对话太长,已省略)"));
  assert.ok(cut[0].content.endsWith(ten("u2")));
  // 留下的第一条是模型说的:去掉,让用户那句打头。
  assert.deepEqual(trimHistory(five, 25).map((row) => row.role), ["user"]);
  // 最新一句再长也发。
  const huge = trimHistory([turn("user", "旧"), turn("user", "x".repeat(100))], 50);
  assert.equal(huge.length, 1);
  assert.ok(huge[0].content.endsWith("x".repeat(100)));
  const pics = trimHistory([turn("user", "图1", "AAA"), turn("assistant", "看到了"), turn("user", "图2", "BBB"),
    turn("user", "图3", "CCC")], 60000);
  assert.deepEqual(pics.map((row) => row.imageB64), ["", "", "BBB", "CCC"]);
  assert.equal(pics[0].content, "图1\n(这里原来有一张图片,太早了没再发)");
  // ETS 版同一组数、同两句话,并且真的接在发给模型的历史上。
  const protoSrc = readFileSync(new URL("../app/entry/src/main/ets/local/LocalProtocol.ets", import.meta.url), "utf8");
  assert.match(protoSrc, /HISTORY_CHAR_BUDGET: number = 60000;/);
  assert.match(protoSrc, /HISTORY_IMAGE_KEEP: number = 2;/);
  assert.match(protoSrc, /IMAGE_CHAR_COST: number = 1500;/);
  assert.ok(protoSrc.includes("(这里原来有一张图片,太早了没再发)"));
  assert.ok(protoSrc.includes("(更早的对话太长,已省略)"));
  assert.match(protoSrc, /while \(out\.length > 1 && out\[0\]\.role !== 'user'\)/);
  const chatSrc = readFileSync(new URL("../app/entry/src/main/ets/local/ChatRun.ets", import.meta.url), "utf8");
  assert.match(chatSrc, /return trimHistory\(out, HISTORY_CHAR_BUDGET\);/);
}

{
  // --- 0.3.0-alpha.18 对齐:远控(鸿蒙指挥 Mac)和被控(别人指挥这台鸿蒙) ---
  const etsSrc = (rel) => readFileSync(new URL(`../app/entry/src/main/ets/${rel}`, import.meta.url), "utf8");
  const harness = etsSrc("net/HarnessClient.ets");
  const chat = etsSrc("panes/ChatPane.ets");
  const machines = etsSrc("net/MachinesClient.ets");
  const outbound = etsSrc("net/OutboundClient.ets");
  const codec = etsSrc("net/OutboundCodec.ets");
  const router = etsSrc("local/HarmonyMinisRouter.ets");
  const engine = etsSrc("local/LocalAgentEngine.ets");

  // 403 是 Mac 自己的答复,不能再报成「钥匙不对」;请求带编号、等够 60 秒。
  const throwIfBad = harness.slice(harness.indexOf("private throwIfBad("));
  assert.ok(/if \(code === 401\) \{\s*throw new HttpError\(HarnessClient\.KEY_REJECTED/.test(throwIfBad), "只有 401 是钥匙不对");
  assert.ok(!/code === 403\) \{\s*throw/.test(throwIfBad));
  assert.ok(/'X-Leo-Request-Id': util\.generateRandomUUID/.test(harness), "每个请求带编号,Mac 按它去重");
  assert.ok(/readTimeout: 65000/.test(harness), "等够中继的 60 秒");
  // 打开机器不再建空任务;第一条消息才建(带着这句话)。
  const start = chat.slice(chat.indexOf("private startSession("), chat.indexOf("private teardown("));
  assert.ok(!/client\.create\(/.test(start), "打开机器时不在 Mac 上建任务");
  assert.ok(/this\.sessionId = await this\.createTask\(text, auto\)/.test(chat) &&
    /client\.create\(ChatLaunch\.harness, text, '', auto\)/.test(chat), "第一条消息建任务并直接跑这一句");
  // 这台鸿蒙是「全自动」时,Mac 上的 LeoPhoneAgent 任务也全自动(iOS 同样);Mac 不接受就退回逐项审批一次。
  assert.ok(/const auto = zcode && SensitiveToolGate\.fullAuto && !this\.fullAutoRefused/.test(chat));
  assert.ok(/err\.code !== 403/.test(chat) && /client\.create\(ChatLaunch\.harness, text, '', false\)/.test(chat));
  assert.ok(/this\.client\.send\(this\.sessionId, text, '', zcode \? \(auto \? 1 : 0\) : -1\)/.test(chat));
  assert.ok(/body\['full_auto'\] = true/.test(harness) && /body\['full_auto'\] = fullAuto === 1/.test(harness));
  // 回放的旧帧不重置重连计数;一轮结束后正常关流就不再重连。
  assert.ok(!/this\.reconnects = 0;\s*this\.onEvent/.test(chat), "不再每来一帧就清零重连计数");
  assert.ok(/if \(this\.ended && message === '已断开'\)/.test(chat));
  // 一轮结束清掉审批卡;409 当作已处理;按 Mac 给的答法出按钮。
  assert.ok(/name === 'run\.completed' \|\| name === 'run\.failed' \|\| name === 'run\.cancelled'\) \{\s*\/\/[^\n]*\n\s*this\.approvalQueue = \[\]/.test(chat));
  assert.ok(/err\.code === 409/.test(chat));
  assert.ok(/ForEach\(this\.approval\.choices/.test(chat) && /'本次会话允许'/.test(chat) && /'拒绝并停止任务'/.test(chat));
  assert.ok(/name === 'session\.note'/.test(chat), "Mac 的提示要显示");
  assert.ok(/'status'\] \?\? ''\}` === 'gap'/.test(chat), "续传缺口要处理");
  // 配对:等 Mac 批准,错误用中继给的原因。
  assert.ok(/responseCode === 202/.test(machines) && /joinStatus\(/.test(machines));
  assert.ok(/HarnessClient\.messageFrom\(raw, resp\.responseCode\)/.test(machines), "配对失败说真实原因");

  // 被控:缺口在流里说,未知会话在流里 run.failed,25 秒保活,关闭码看得见,请求编号去重。
  assert.ok(!/json\(410/.test(router), "不再回 410(到不了控制端)");
  const openStream = /private openStream\([\s\S]*?\n  \}/.exec(outbound)[0];
  const nonStream = openStream.slice(0, openStream.indexOf("harmonyRouter.replay"));
  assert.ok(!/respJson\(/.test(nonStream) && /run\.failed/.test(nonStream) && /streamCloseJson\(id\)/.test(nonStream));
  assert.ok(/stream_keepalive/.test(codec));
  const androidOutbound = readFileSync(new URL("../../android/app/src/main/java/com/leoyuan/leophoneagent/relay/RelayOutboundClient.kt", import.meta.url), "utf8");
  assert.equal(/STREAM_KEEPALIVE_MS: number = (\d+)/.exec(outbound)[1], /STREAM_KEEPALIVE_MS = ([\d_]+)L/.exec(androidOutbound)[1].replace(/_/g, ""), "和安卓同一个保活间隔");
  assert.ok(/code === 4001/.test(outbound) && /code === 4003/.test(outbound));
  assert.ok(/frame\.requestId/.test(outbound) && /request_id/.test(codec));

  // 控制端看到的文字不重复:和安卓 HeadlessDeltaTest 同样的用例。
  assert.equal(nextDelta("", "Hello"), "Hello");
  assert.equal(nextDelta("Hello", "Hello world"), " world");
  assert.equal(nextDelta("Hello", "Hello"), "");
  assert.equal(nextDelta("Hello wor", ""), "");
  assert.equal(nextDelta("Hello wor", "Hel"), "");
  assert.equal(nextDelta("Hello wor", "Hello world"), "ld");
  assert.equal(nextDelta("Hello", "Hi there"), "i there");
  assert.ok(/draft\.text = draft\.base/.test(engine), "换模型重来时退回这一轮开头");
  assert.ok(/shown\.length > 0 \? shown : output/.test(router), "完成时给控制端已显示的全文");
}

{
  // 本机 Agent 的纯文本逻辑(AgentText.ets):镜像一字不差,提示词和 iOS 同文。
  const ets = readFileSync(new URL("../app/entry/src/main/ets/local/AgentText.ets", import.meta.url), "utf8");
  const mirror = readFileSync(new URL("./agentText.ts", import.meta.url), "utf8");
  assert.ok(mirror.includes(ets), "protocol/agentText.ts 要和 AgentText.ets 一字不差");
  const t = agentText;
  const L = (role, text, kind = "") => Object.assign(new t.TextLine(), { role, text, kind });

  // 压缩:保留最后 3 个用户回合,前面交给模型;摘要包进第一句用户消息;稿子里认工具行
  const lines = [L("user", "u1"), L("assistant", "a1"), L("system", t.toolPlanLine(["file_write"])),
    L("system", t.toolResultLine("file_write", "已写入 a.md")), L("user", "u2"), L("assistant", "a2"),
    L("user", "u3"), L("assistant", "a3"), L("user", "u4")];
  assert.equal(t.compactCut(lines, 3), 4);
  assert.equal(t.compactCut(lines, 4), -1, "分界前没东西可压");
  assert.equal(t.compactCut([L("user", "only")], 1), -1);
  const transcript = t.compactTranscript(lines.slice(0, 4), "");
  assert.equal(transcript, "[User] u1\n[Assistant] a1\n[Tool] file_write\n[Result] file_write: 已写入 a.md");
  assert.ok(t.compactTranscript([L("user", "x")], "旧摘要").startsWith("Previous context summary:\n旧摘要\n\nNew conversation to merge:\n[User] x"));
  assert.ok(t.COMPACT_SYSTEM_PROMPT.startsWith("You are a context compaction engine."));
  assert.ok(t.compactUserMessage("X").includes("\n\nX\n\n---\nEND OF CONVERSATION TO COMPACT."));
  assert.ok(t.summaryWrapper("S").startsWith("<context-summary>\n") && t.summaryWrapper("S").endsWith("\n\nS\n</context-summary>"));
  const withSummary = [L("user", "old"), L("system", "摘要", "summary"), L("user", "12345"), L("assistant", "678")];
  assert.equal(t.lastSummaryIndex(withSummary), 1);
  assert.equal(t.historyChars(withSummary), 8, "只算摘要之后的");
  assert.equal(t.compactCut(withSummary, 1), -1);

  // 标题:iOS 同一套提示词;回复按 JSON → "title" → 短纯文本 读
  assert.equal(t.titleExcerpt([L("user", "帮我写周报")]), "", "没有回答不起标题");
  assert.equal(t.titleExcerpt([L("user", "Q1"), L("assistant", "A1")]), "User: Q1\n\nAssistant: A1");
  assert.ok(t.titleExcerpt([L("user", "Q1"), L("assistant", "A1"), L("user", "Q2"), L("assistant", "A2")])
    .endsWith("[... middle of conversation omitted ...]\n\nUser: Q2\n\nAssistant: A2"));
  assert.ok(t.titlePrompt("E").startsWith("Based on the following conversation, generate a short title (max 6 words)"));
  assert.ok(t.titlePrompt("E").endsWith("Conversation:\nE"));
  assert.equal(t.parseTitleReply('{"title": "整理周报", "category": "writing"}'), "整理周报");
  assert.equal(t.parseTitleReply('好的:{"title":"「修登录页」"'), "修登录页");
  assert.equal(t.parseTitleReply("修复登录页"), "修复登录页");
  assert.equal(t.parseTitleReply("第一行\n第二行"), "");

  // 中断:最后是用户的话、停下的半截回答、工具行 → 没做完
  assert.equal(t.unfinishedTail([L("user", "q")]), true);
  assert.equal(t.unfinishedTail([L("user", "q"), L("assistant", "a")]), false);
  assert.equal(t.unfinishedTail([L("user", "q"), L("assistant", "半截", "partial")]), true);
  assert.equal(t.unfinishedTail([L("user", "q"), L("system", t.toolPlanLine(["web_fetch"]))]), true);
  assert.equal(t.unfinishedTail([L("system", "已写入今日记忆")]), false);
  const note = t.resumeNote([L("user", "q"), L("system", t.toolPlanLine(["file_write", "web_fetch"])),
    L("system", t.toolResultLine("file_write", "已写入 a.md"))], 3);
  assert.ok(note.startsWith(t.CONTINUE_REMINDER));
  assert.ok(note.includes("[Result] file_write: 已写入 a.md"));
  assert.ok(note.includes(`[Lost] web_fetch: ${t.LOST_TOOL_NOTE}`));
  assert.equal(t.resumeNote([L("user", "q"), L("assistant", "半截", "partial")], 2), t.CONTINUE_REMINDER);

  // 技能:--- 头读 name / description(| 多行),没有头时用正文第一行;索引和 iOS 同格式
  const skill = t.parseSkillMeta("---\nname: Weekly Report\ndescription: |\n  写周报\n  的格式\n---\n正文", "x");
  assert.equal(skill.id, "weekly-report");
  assert.equal(skill.description, "写周报\n的格式");
  const plain = t.parseSkillMeta("# 整理会议纪要\n先列决定", "会议 纪要");
  assert.equal(plain.id, "会议-纪要");
  assert.equal(plain.description, "整理会议纪要");
  assert.equal(t.skillIdFromPath("skills/weekly-report/SKILL.md"), "weekly-report");
  assert.equal(t.skillIdFromPath("/var/minis/skills/weekly-report/SKILL.md"), "weekly-report");
  assert.equal(t.skillIdFromPath("notes.md"), "");
  const many = Array.from({ length: 22 }, (_, i) => Object.assign(new t.SkillMeta(), { id: `s${String(i).padStart(2, "0")}`, name: `s${i}`, description: "d".repeat(300) }));
  const index = t.skillsPromptBlock(many);
  assert.ok(index.startsWith("Skills:\nReusable instruction sets stored at skills/<name>/SKILL.md."));
  assert.equal((index.match(/<skill>/g) ?? []).length, 20);
  assert.ok(index.includes(`<description>${"d".repeat(200)}…</description>`));
  assert.ok(index.includes("2 more skills not shown above: s20, s21."));
  assert.equal(t.skillsPromptBlock([]), "");

  // MCP:握手参数、SSE 取 id 对得上的那条、错误
  assert.equal(JSON.parse(t.mcpInitializeParams("0.3.0")).protocolVersion, "2025-06-18");
  assert.equal(JSON.parse(t.mcpRequest(7, "tools/list", "{}")).id, 7);
  assert.equal(JSON.parse(t.mcpNotification("notifications/initialized")).id, undefined);
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\ndata: {"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"search"},{"name":"read"}]}}\n\n';
  assert.deepEqual(t.mcpToolNames(t.mcpReply(sse, 3)), ["search", "read"]);
  assert.equal(t.mcpReply('{"jsonrpc":"2.0","id":1,"result":{}}', 1), '{"jsonrpc":"2.0","id":1,"result":{}}');
  assert.equal(t.mcpError('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}'), "Method not found");
  assert.equal(t.mcpError('{"jsonrpc":"2.0","id":1,"result":{}}'), "");
  assert.ok(t.mcpPromptBlock(["zhipu"], ["web_search_prime"]).includes("- zhipu: web_search_prime"));
  assert.equal(t.mcpPromptBlock([], []), "");

  // 搜索:Bing 跳转链接解出真实地址;DuckDuckGo 的 uddg
  const bing = t.parseBingResults('<ol><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9h&amp;ntb=1">Ex <strong>A</strong></a></h2><div class="b_caption"><p class="b_lineclamp2">Snip &amp; more</p></div></li><li class="b_algo b_vtl"><h2><a href="https://direct.cn/x">直达</a></h2></li></ol>', 5);
  assert.deepEqual(bing.map((hit) => [hit.title, hit.url, hit.snippet]), [["Ex A", "https://example.com/a", "Snip & more"], ["直达", "https://direct.cn/x", ""]]);
  const ddg = t.parseDdgResults('<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fp&amp;rut=1">Org <b>P</b></a><a class="result__snippet" href="x">about p</a>', 5);
  assert.deepEqual(ddg.map((hit) => [hit.title, hit.url, hit.snippet]), [["Org P", "https://example.org/p", "about p"]]);
  assert.ok(t.formatSearchHits("q", bing).startsWith("搜索「q」的前 2 条结果:\n1. Ex A\n   https://example.com/a\n   Snip & more"));
  assert.ok(t.formatSearchHits("q", []).includes("https://cn.bing.com/search?q=q"));

  // 定时任务:今天到点、今天没跑过才跑;关着 App 错过的回来补今天这一次
  const nine = new Date(2026, 8, 26, 9, 0, 0).getTime();
  assert.equal(t.scheduleDue(9, 0, true, "", nine), true);
  assert.equal(t.scheduleDue(9, 0, true, t.dayKeyOf(nine), nine), false);
  assert.equal(t.scheduleDue(9, 1, true, "", nine), false);
  assert.equal(t.scheduleDue(8, 0, false, "", nine), false);
  assert.equal(t.scheduleDue(8, 0, true, "2026-9-25", nine + 3600000 * 5), true, "错过的回来补");

  // 完成通知:iOS 的写法
  assert.deepEqual(t.doneNotice("done", "周报", "## 好了\n**写完**了"), ["✅ 周报", "好了 写完了"]);
  assert.deepEqual(t.doneNotice("done", "", ""), ["✅ 本机任务", "任务已完成。"]);
  assert.deepEqual(t.doneNotice("interrupted", "周报", "x"), ["⏸ 周报", "任务中断,回到 app 可继续。"]);
  assert.equal(t.doneNotice("failed", "周报", "")[1], "任务执行失败。");
  assert.deepEqual(t.doneNotice("approval", "周报", ""), ["✋ 周报", "要写文件,等你确认。"]);
  assert.equal(t.attachedFilesBlock(["a.pdf", "b.png"]), '<user-attached-files>\n  <file path="a.pdf" />\n  <file path="b.png" />\n</user-attached-files>');
  assert.equal(t.attachedFilesBlock([]), "");
  assert.equal(t.plainPreview("x".repeat(300), 200).length, 201);
}

{
  // --- 本机独立能力第二批:后台接着跑、继续、压缩、标题、技能、MCP、搜索、看图、附件、App 关着的定时任务 ---
  const etsSrc = (rel) => readFileSync(new URL(`../app/entry/src/main/ets/${rel}`, import.meta.url), "utf8");
  const run = etsSrc("local/ChatRun.ets");
  const pane = etsSrc("panes/LocalChatPane.ets");
  const entry = etsSrc("entryability/EntryAbility.ets");
  const sessions = etsSrc("store/SessionStore.ets");
  const schedule = etsSrc("store/ScheduleStore.ets");
  const runner = etsSrc("local/ScheduleRunner.ets");
  const work = etsSrc("workscheduler/ScheduleWork.ets");
  const tools = etsSrc("local/LocalTools.ets");
  const mcp = etsSrc("store/McpStore.ets");
  const skills = etsSrc("store/SkillStore.ets");
  const proto = etsSrc("local/LocalProtocol.ets");
  const client = etsSrc("local/OpenAICompatClient.ets");
  const moduleJson = readFileSync(new URL("../app/entry/src/main/module.json5", import.meta.url), "utf8");

  // 后台:退到后台申请短时任务;快用完时停下、回前台接着跑;在后台说完发通知,点开回到这个对话
  assert.ok(/requestSuspendDelay\(/.test(run) && /run\.pauseForBackground\(\)/.test(run));
  assert.ok(/static onForeground\(\): void \{[\s\S]{0,200}run\.resumeIfPaused\(\)/.test(run));
  assert.ok(/if \(!ChatRuns\.foreground\) \{\s*ChatRuns\.notify\(/.test(run), "只在后台时发通知");
  assert.ok(/parameters: \{ 'openSession': sessionId \}/.test(run) && /AppStorage\.setOrCreate\('openSession', id\)/.test(entry));
  assert.ok(/onNewWant\(want: Want/.test(entry) && /ChatRuns\.onBackground\(ScheduleRunner\.busy\)/.test(entry));
  assert.ok(/requestEnableNotification\(context\)/.test(run), "第一次跑任务时问通知权限");

  // 继续:一轮开始时落盘 running,被杀后读回来就知道没做完;停下存半截回答
  assert.ok(/sessionStore\.setRunning\(this\.context, this\.sessionId, true\)/.test(run));
  assert.ok(/this\.interrupted = session\.running \|\| unfinishedTail\(textLines\(session\.messages\)\)/.test(run));
  assert.ok(/session\.running = obj\['running'\] === true/.test(sessions));
  assert.ok(/line\.kind = 'partial'/.test(run) && /line\.kind = 'resume'/.test(run));
  assert.ok(/content = resumeNote\(all, i\)/.test(run) && /\$\{line\.text\}\\n\\n\$\{STOPPED_NOTE\}/.test(run));
  assert.ok(/this\.run\.resume\(this\.thinking\)/.test(pane) && pane.includes("已中断 - 点击「继续」以恢复"), "和安卓同一句");

  // 压缩:发送前超过门槛先压;摘要包进第一句用户消息;/compact 手动
  assert.ok(/historyChars\(textLines\(session\.messages\)\) > COMPACT_AT_CHARS/.test(run));
  assert.ok(/const wrapped = summaryWrapper\(messages\[start\]\.text\)/.test(run));
  assert.ok(/cmd === '\/compact'/.test(run) && /marker\.kind = 'summary'/.test(run));
  assert.ok(etsSrc("chat/ChatViews.ets").includes("已压缩前面 ${this.item.count} 条消息"));
  // 写摘要、起标题不带工具
  assert.ok(/}, false\);/.test(etsSrc("local/SideModel.ets")) && /const tools = withTools \?/.test(client));
  const noTools = JSON.parse(responsesBodyJson("m", "s", [{ role: "user", content: "hi" }], "[]", ""));
  assert.equal(noTools.tools, undefined);
  assert.equal(noTools.tool_choice, undefined);
  assert.ok(/const tools = withTools \? `"parallel_tool_calls":true,"tools"/.test(proto));

  // 标题:只替换自动起的标题,改过名的不动
  assert.ok(/if \(before !== '新任务' && before !== titleFromPrompt\(firstUser\)\)/.test(run));
  assert.ok(/now\.title !== before/.test(run));

  // 技能:提示词里只放索引,file_read 读 skills/<id>/SKILL.md
  assert.ok(/return skillsPromptBlock\(/.test(skills) && /bodyFor\(id: string\)/.test(skills));
  assert.ok(/skillIdFromPath\(raw\)/.test(tools) && /skillStore\.bodyFor\(skillId\)/.test(tools));

  // MCP:握手、Accept 带 event-stream、会话号、过期重握手;结果原样给模型
  assert.ok(/'initialize', mcpInitializeParams\(/.test(mcp) && /mcpNotification\('notifications\/initialized'\)/.test(mcp));
  assert.ok(/'Accept': 'application\/json, text\/event-stream'/.test(mcp) && /header\['Mcp-Session-Id'\] = session/.test(mcp));
  assert.ok(/resp\.code === 404 && \(McpStore\.sessions\.get\(row\.label\) \?\? ''\)\.length > 0/.test(mcp));
  assert.ok(/name === 'mcp_tools'/.test(tools) && /envStore\.expand\(row\.url\)/.test(mcp));
  assert.equal(toolArg('{"arguments":{"q":"x"}}', "arguments"), '{"q":"x"}', "对象参数不再变成 [object Object]");
  assert.ok(/typeof value === 'object' \? JSON\.stringify\(value\)/.test(proto));

  // 搜索和看图
  assert.ok(/cn\.bing\.com\/search/.test(tools) && /html\.duckduckgo\.com/.test(tools));
  assert.ok(/const IMAGE_EDGE = 2000/.test(tools) && /quality: 85/.test(tools) && /out\.imageB64 = /.test(tools));
  assert.ok(/tool\.imageB64 = result\.imageB64/.test(run) && /tool\.imageB64 = result\.imageB64/.test(etsSrc("local/LocalAgentEngine.ets")));
  // read_image 的图:Responses 在工具输出后面补一条用户消息;Anthropic 放进 tool_result;OpenAI、Gemini 同 Responses
  const input = JSON.parse(responsesInputJson([
    { role: "assistant", content: "", calls: [{ id: "c1", name: "read_image", args: "{}" }] },
    { role: "tool", content: "Image loaded", toolCallId: "c1", imageB64: "QUJD", imageMime: "image/jpeg" },
  ]));
  assert.equal(input[1].type, "function_call_output");
  assert.deepEqual(input[2].content.map((part) => part.type), ["input_text", "input_image"]);
  assert.equal(input[2].content[0].text, TOOL_IMAGE_CAPTION);
  assert.ok(/"content":\[\{"type":"text","text":\$\{JSON\.stringify\(turn\.content\)\}\},\{"type":"image","source"/.test(proto));
  assert.equal((proto.match(/flushImages\(\);/g) ?? []).length >= 6, true, "OpenAI、Gemini、Responses 三处都在工具串后补图");

  // 附件:进沙箱,消息里只带清单
  assert.ok(/WorkspaceStore\.saveUpload\(ctx, name, buf\)/.test(etsSrc("chat/Attachments.ets")) &&
    /Attachments\.pickFiles\(/.test(pane) && /attachedFilesBlock\(line\.files\)/.test(run));
  const archive = sessionArchiveFromJson({ messages: [{ role: "user", text: "看", files: ["a.pdf"] }, { role: "system", text: "摘要", kind: "summary", count: 4 }] });
  assert.deepEqual(archive.messages[0].files, ["a.pdf"]);
  assert.equal(archive.messages[1].kind, "summary");
  assert.equal(archive.messages[1].count, 4);

  // App 关着的定时任务:登记延迟任务,系统唤起 ScheduleWork;界面在前台时它让开;错过的回来补今天这一次
  assert.ok(/"type": "workScheduler"/.test(moduleJson) && /"srcEntry": "\.\/ets\/workscheduler\/ScheduleWork\.ets"/.test(moduleJson));
  assert.ok(/abilityName: 'ScheduleWork'/.test(runner) && /workScheduler\.startWork\(work\)/.test(runner));
  assert.ok(/if \(UiState\.uiBusy\(this\.context\)\) \{\s*return;/.test(work) && /ScheduleRunner\.runDue\(this\.context, true\)/.test(work));
  assert.ok(/scheduleDue\(row\.hour, row\.minute, row\.on, row\.lastDay, now\)/.test(schedule));
  assert.ok(/if \(retimed && fire\.getTime\(\) <= Date\.now\(\)\)/.test(schedule), "新建时今天的点已过,从明天开始");
  assert.ok(/await sessionStore\.reload\(this\.context\);/.test(entry), "后台进程写过档案,回前台重读");
}

{
  // 聊天界面的纯逻辑(AgentText.ets):Markdown、工具行、条目分组和折叠
  const t = agentText;
  const L = (role, text, kind = "", at = 0) => Object.assign(new t.TextLine(), { role, text, kind, at });

  // Markdown 块
  const blocks = t.mdBlocks("# 标题\n正文第一行\n第二行\n\n```Swift\nlet a = 1\n```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n> 引用\n- 项\n  - 子项\n- [x] 完成\n2. 第二\n---\n```py\n没收尾");
  assert.deepEqual(blocks.map((b) => b.kind), ["h1", "p", "code", "table", "quote", "li", "li", "li", "ol", "hr", "code"]);
  assert.equal(blocks[1].text, "正文第一行\n第二行");
  assert.equal(blocks[2].lang, "swift");
  assert.equal(blocks[2].text, "let a = 1");
  assert.deepEqual(t.mdTableRows(blocks[3].text), [["a", "b"], ["1", "2"]]);
  assert.equal(blocks[6].level, 1);
  assert.equal(blocks[7].text, "☑ 完成");
  assert.equal(blocks[8].ordinal, "2");
  assert.equal(blocks[10].text, "没收尾", "流式时没收尾的代码块照样是代码块");
  // 行内
  const runs = t.mdInline("用 `ls` 看，**重要**，*斜*，~~删~~，[文档](https://a.cn/x)，见 https://b.cn/y。");
  assert.deepEqual(runs.map((r) => [r.kind, r.text]), [["text", "用 "], ["code", "ls"], ["text", " 看，"], ["bold", "重要"], ["text", "，"],
    ["italic", "斜"], ["text", "，"], ["strike", "删"], ["text", "，"], ["link", "文档"], ["text", "，见 "], ["link", "https://b.cn/y"], ["text", "。"]]);
  assert.equal(runs[9].url, "https://a.cn/x");
  assert.deepEqual(t.mdInline("snake_case_name 不是斜体").map((r) => r.kind), ["text"]);

  // 工具结果行带标题,续跑和显示都读得回
  assert.equal(t.toolResultLine("web_search", "3 条", "搜北京天气"), "工具 web_search「搜北京天气」: 3 条");
  assert.equal(t.toolResultLine("file_list", "空", "file_list"), "工具 file_list: 空");
  const row = t.parseToolRow("web_search「搜: 天气」: 3 条");
  assert.deepEqual([row.name, row.title, row.result], ["web_search", "搜: 天气", "3 条"]);
  assert.deepEqual([t.parseToolRow("file_list: a.md").name, t.parseToolRow("file_list: a.md").result], ["file_list", "a.md"]);
  assert.ok(t.resumeNote([L("user", "q"), L("system", t.toolPlanLine(["web_search"])),
    L("system", t.toolResultLine("web_search", "3 条", "搜天气"))], 3).includes("[Result] web_search: 3 条"));

  // 分组:第一轮两步工具、有回答、不是最新一轮 → 折成「已工作 2 步」;点开后工具胶囊回来
  const convo = [
    L("user", "查天气然后记下来", "", 1000),
    L("assistant", "我先查一下", "", 2000),
    L("system", t.toolPlanLine(["weather", "memory_write"]), "", 2000),
    L("system", t.toolResultLine("weather", "晴 20 度", "查北京天气"), "", 5000),
    L("system", t.toolResultLine("memory_write", "已写入今日记忆"), "", 6000),
    L("assistant", "北京晴,20 度,已经记下。", "", 8000),
    L("user", "再搜一下明天", "", 9000),
    L("system", t.toolPlanLine(["web_search"]), "", 9500),
  ];
  const folded = t.chatItems(convo, true, []);
  assert.deepEqual(folded.map((i) => i.kind), ["user", "assistant", "worked", "assistant", "user", "tool"]);
  assert.equal(folded[1].head, true, "回答头画在这一轮第一条");
  assert.equal(folded[2].count, 2);
  assert.equal(folded[2].seconds, 4, "两步工具各 3 秒、1 秒");
  assert.equal(folded[3].last, true, "说完的一轮最后一段回答下面有操作");
  assert.equal(folded[5].status, "running", "最新一轮还在跑");
  assert.equal(folded[5].head, true);
  const opened = t.chatItems(convo, true, [0]);
  assert.deepEqual(opened.map((i) => i.kind), ["user", "assistant", "worked", "tool", "tool", "assistant", "user", "tool"]);
  assert.equal(opened[3].title, "查北京天气");
  assert.equal(opened[3].seconds, 3);
  // 关掉「工具预览」:说完的都折,正在跑的那一轮不折
  assert.deepEqual(t.chatItems(convo, true, [], true).map((i) => i.kind), ["user", "assistant", "worked", "assistant", "user", "tool"]);
  const oneTool = [L("user", "q"), L("system", t.toolPlanLine(["file_list"])), L("system", t.toolResultLine("file_list", "a.md")), L("assistant", "有 a.md")];
  assert.deepEqual(t.chatItems(oneTool, false, [], true).map((i) => i.kind), ["user", "worked", "assistant"]);
  assert.deepEqual(t.chatItems(oneTool, false, [], false).map((i) => i.kind), ["user", "tool", "assistant"]);
  const stopped = t.chatItems(convo, false, []);
  assert.equal(stopped[stopped.length - 1].status, "lost", "App 停了还没配上结果的算没跑完");
  // 只有一步工具不折;最新一轮不折;等模型时有「正在思考」
  const one = t.chatItems([L("user", "q"), L("system", t.toolPlanLine(["file_list"])), L("system", t.toolResultLine("file_list", "a.md")),
    L("assistant", "有 a.md"), L("user", "q2")], true, []);
  assert.deepEqual(one.map((i) => i.kind), ["user", "tool", "assistant", "user", "typing"]);
  assert.equal(one[1].status, "ok");
  assert.equal(t.chatItems([L("user", "q"), L("system", t.toolPlanLine(["x"])), L("system", t.toolResultLine("x", "没有这个工具：x"))], false, [])[1].status, "fail");
  // 摘要、错误、说到一半的回答
  const misc = t.chatItems([L("system", "摘要", "summary"), L("user", "q"), L("assistant", "说到一半", "partial"), L("system", "网络断了", "error"), L("system", "换到 gpt")], false, []);
  assert.deepEqual(misc.map((i) => i.kind), ["summary", "user", "assistant", "error", "notice"]);
  assert.equal(misc[2].partial, true);
  assert.equal(t.chatItems([], true, []).length, 0);

  assert.equal(t.durationText(-1), "");
  assert.equal(t.durationText(42), "42 秒");
  assert.equal(t.durationText(72), "1 分 12 秒");
  assert.equal(t.durationText(120), "2 分钟");
  assert.equal(t.toolLabel("web_search", ""), "搜网页");
  assert.equal(t.toolLabel("web_search", "搜北京天气"), "搜北京天气");
  assert.equal(t.toolLabel("custom_tool", ""), "custom_tool");
}

{
  // 界面:用到的每个图标名都在 Symbols.ets 里(写错会悄悄变成「⋯」);折叠屏展开按宽度分栏;首页导航
  const etsRoot = new URL("../app/entry/src/main/ets/", import.meta.url);
  const src = (rel) => readFileSync(new URL(rel, etsRoot), "utf8");
  const symbols = new Set([...src("theme/Symbols.ets").matchAll(/this\.name === '([a-z0-9_]+)'/g)].map((m) => m[1]));
  const used = new Set();
  const files = ["chat/ChatViews.ets", "chat/Composer.ets", "panes/LocalChatPane.ets", "panes/LocalAgentPane.ets",
    "panes/SettingsPane.ets", "panes/FleetPane.ets", "panes/ChatPane.ets", "theme/Markdown.ets", "theme/Widgets.ets"];
  for (const f of files) {
    const text = src(f);
    for (const m of text.matchAll(/Sym\(\{\s*name:\s*'([a-z0-9_]+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/name:\s*this\.[a-zA-Z]+ \? '([a-z0-9_]+)' : '([a-z0-9_]+)'/g)) { used.add(m[1]); used.add(m[2]); }
    for (const m of text.matchAll(/(?:barIcon|menuRow|chip)\((?:'[^']*', )?'([a-z0-9_]+)'/g)) if (m[1] !== "dot") used.add(m[1]);
    for (const m of text.matchAll(/this\.quickTask\([^)]*?, '([a-z0-9_]+)', [^)]*\)/g)) used.add(m[1]);
    for (const m of text.matchAll(/row\('([a-z0-9_]+)', '#/g)) used.add(m[1]);
  }
  for (const m of src("chat/ChatViews.ets").matchAll(/return '([a-z0-9_]+)';/g)) used.add(m[1]);
  const legacy = src("theme/Widgets.ets");
  for (const m of legacy.slice(legacy.indexOf("function symbolFor"), legacy.indexOf("@Component\nexport struct IconCircle")).matchAll(/: '([a-z0-9_]+)'/g)) used.add(m[1]);
  assert.ok(used.size > 40, `找到的图标太少(${used.size}),正则可能失效`);
  const missing = [...used].filter((name) => !symbols.has(name));
  assert.deepEqual(missing, [], "这些图标名不在 Symbols.ets 里");

  // 折叠屏展开(近似正方形、略高)也分栏:不再要求横着拿
  const fold = src("layout/FoldLayout.ets");
  assert.ok(!/width < height/.test(fold), "分栏只看宽度");
  assert.ok(/width < Tokens\.wideBreak/.test(fold) && /height < Tokens\.tallBreak/.test(fold));
  // 手机首页:没有「本机 / 远程」文字页签,远程是顶栏的电脑图标
  const home = src("pages/HomePage.ets");
  assert.ok(!/tabLabel\(/.test(home) && /pushUrl\(\{ url: 'pages\/FleetPage' \}\)/.test(home));
  // 输入框:在跑且没打字时是红色停止;芯片在卡片里
  const composer = src("chat/Composer.ets");
  assert.ok(/this\.running && this\.draft\.trim\(\)\.length === 0/.test(composer) && /backgroundColor\(Tokens\.danger\)/.test(composer));
  assert.ok(/'全自动' : '逐项确认'/.test(composer));
  // 回答不套气泡:直接画 Markdown,上面一行「✦ LeoPhoneAgent」
  const pane = src("panes/LocalChatPane.ets");
  assert.ok(/AssistantHead\(\{ name: this\.agentName\(\) \}\)/.test(pane) && /MarkdownText\(\{ text: item\.text \}\)/.test(pane));
  assert.ok(/chatItems\(textLines\(run\.lines\), run\.active \|\| run\.askWrite, this\.openTurns, !themeStore\.toolPreview\)/.test(pane));
  // 设置四组,和 iOS / 安卓同顺序
  const settings = src("panes/SettingsPane.ets");
  assert.ok(/const all: SetGroup\[\] = \[device, agent, look, data\]/.test(settings));
}

console.log("PROTOCOL_MACHINES_OK");
