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
import { capabilitiesFromJson, sessionSummaryFromJson } from "./harnessTypes.ts";
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
  usageFromJson,
  fileReadPage,
  formatFileReadOutput,
} from "./localChat.ts";
import { enrichEvent, nowSeconds, replayAfter, dueTasks, dayKey, scheduleSessionTitle, lastRunLabel } from "./bodyRuntime.ts";
import {
  skipUpstreamModels,
  modelsAuthHeaders,
  modelsListUrl,
  modelIdsFromListJson,
  modelsDevProviderKey,
  idsFromModelsDevJson,
  fallbackModelIds,
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
} from "./codexResponses.ts";

const ROOT = "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api";

{
  const rows = parseMachines({
    machines: [
      { name: "LeodeMac-mini-2", online: true, server: "leocodebox" },
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
  assert.equal(sanitizeKey("  abcdefghijklmnop%\n"), "abcdefghijklmnop");
  assert.equal(requireHttpsRoot(ROOT + "/"), ROOT);
  assert.throws(() => requireHttpsRoot("http://evil.example/relay/api"));
  assert.throws(() => requireHttpsRoot("https://user:pass@evil.example/relay/api"));
  const next = applyDiscovery(
    [{ name: "LeoFold8", online: true }, { name: "Mac", online: true }],
    [{ name: "Mac", online: true, platform: null, server: "leocodebox", version: null }],
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
const macRoutes = src("../../mac/leocodebox/server/modules/leophone/leophone.routes.ts");
const macSession = src("../../mac/leocodebox/server/modules/leophone/harness-session.service.ts");

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
  const macVersion = /const VERSION = '([^']+)'/.exec(macRoutes);
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

  // features 的七个键要跟 Mac 一字不差(值可以不同,键不能少)。
  const macFeatures = /features:\s*\{([\s\S]*?)\n    \}/.exec(macRoutes);
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
  const macPush = /const PUSHABLE_EVENTS = new Set\(\[([\s\S]*?)\]\)/.exec(macSession);
  assert.ok(macPush, "读不到 Mac 的 PUSHABLE_EVENTS");
  const macNames = [...macPush[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
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
  assert.ok(/> afterSeq/.test(macSession), "Mac 也是严格大于");

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
  assert.equal(isAndroidBody({ name: "Mac", online: true, platform: "leoagent", server: "leocodebox", version: "1" }), false);
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

console.log("PROTOCOL_MACHINES_OK");
