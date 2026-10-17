import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptRemoteCandidate,
  candidateTier,
  filterOfferCandidates,
  parseTurnConfig,
  rankAnswerCandidates,
  turnIceServers,
} from "./ice.js";

test("addresses fall into tailnet / lan / srflx / relay tiers", () => {
  assert.equal(candidateTier("100.101.102.103", "host"), "tailnet");
  assert.equal(candidateTier("100.63.0.1", "host"), "other");
  assert.equal(candidateTier("fd7a:115c:a1e0::1", "host"), "tailnet");
  assert.equal(candidateTier("192.168.1.20", "host"), "lan");
  assert.equal(candidateTier("172.20.0.5", "host"), "lan");
  assert.equal(candidateTier("10.0.0.2", "host"), "lan");
  assert.equal(candidateTier("fe80::1", "host"), "lan");
  assert.equal(candidateTier("203.0.113.9", "srflx"), "srflx");
  assert.equal(candidateTier("203.0.113.9", "relay"), "relay");
});

const ANSWER = [
  "v=0",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=mid:0",
  "a=candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host generation 0",
  "a=candidate:2 1 udp 2122194687 abcd-ef.local 50001 typ host generation 0",
  "a=candidate:3 1 udp 1686052607 203.0.113.9 50000 typ srflx raddr 192.168.1.20 rport 50000",
  "a=candidate:4 1 tcp 1518280447 100.90.1.2 9 typ host tcptype active",
  "a=end-of-candidates",
  "",
].join("\r\n");

test("answer candidates: mDNS resolved, tailnet first, priorities rewritten", async () => {
  const { sdp, tiers } = await rankAnswerCandidates(ANSWER, {
    tailnetOnly: false,
    resolve: async (name) => (name === "abcd-ef.local" ? "100.90.1.2" : null),
  });
  const candidates = sdp.split("\r\n").filter((line) => line.startsWith("a=candidate:"));
  assert.deepEqual(tiers, ["tailnet", "tailnet", "lan", "srflx"]);
  // 同为 tailnet:UDP 先于 TCP;mDNS 名已换成真地址。
  assert.match(candidates[0]!, / udp \d+ 100\.90\.1\.2 50001 typ host/);
  assert.match(candidates[1]!, / tcp \d+ 100\.90\.1\.2 9 typ host/);
  assert.match(candidates[2]!, /192\.168\.1\.20/);
  const priority = (line: string) => Number(line.split(" ")[3]);
  assert.ok(priority(candidates[0]!) > priority(candidates[1]!));
  assert.ok(priority(candidates[1]!) > priority(candidates[2]!));
  assert.ok(sdp.includes("a=end-of-candidates"));
  assert.ok(sdp.endsWith("\r\n"));
});

test("tailnet-only keeps only tailnet candidates; unresolved mDNS is dropped", async () => {
  const { sdp, tiers } = await rankAnswerCandidates(ANSWER, {
    tailnetOnly: true,
    resolve: async () => null,
  });
  assert.deepEqual(tiers, ["tailnet"]);
  assert.equal(sdp.split("\r\n").filter((line) => line.startsWith("a=candidate:")).length, 1);
});

test("remote candidates and offers are filtered when tailnet-only", () => {
  const lan = { candidate: "candidate:1 1 udp 2122260223 192.168.1.5 6000 typ host", sdpMid: "0" };
  const tail = { candidate: "candidate:1 1 udp 2122260223 100.70.0.9 6000 typ host", sdpMid: "0" };
  assert.equal(acceptRemoteCandidate(lan, false), true);
  assert.equal(acceptRemoteCandidate(lan, true), false);
  assert.equal(acceptRemoteCandidate(tail, true), true);
  assert.equal(acceptRemoteCandidate({ candidate: "" }, true), true);
  assert.equal(acceptRemoteCandidate({ candidate: "garbage" }, false), false);
  const offer = `v=0\r\na=${lan.candidate}\r\na=${tail.candidate}\r\n`;
  assert.equal(filterOfferCandidates(offer, true), `v=0\r\na=${tail.candidate}\r\n`);
  assert.equal(filterOfferCandidates(offer, false), offer);
});

test("TURN REST credentials are short-lived HMACs; bad config is ignored", () => {
  const config = parseTurnConfig({
    urls: ["stun:mini.example.ts.net:3478", "turn:mini.example.ts.net:3478?transport=udp", "bogus"],
    secret: "0123456789abcdef0123",
    ttl_seconds: 600,
  });
  assert.ok(config);
  const servers = turnIceServers(config, 1_000_000_000_000);
  assert.deepEqual(servers[0], { urls: ["stun:mini.example.ts.net:3478"] });
  assert.equal(servers[1]!.username, "1000000600:leobot");
  assert.equal(servers[1]!.credential, "49LY/wZO24S0v6jlW4sHFpohjD8=");
  assert.equal(parseTurnConfig({ urls: ["turn:x:3478"], secret: "short" }), null);
  assert.equal(parseTurnConfig(null), null);
  assert.deepEqual(turnIceServers(null, 0), []);
});
