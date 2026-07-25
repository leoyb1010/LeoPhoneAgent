/**
 * Loopback proxy surface for the Leoapi gateway. Mounted OUTSIDE `/api` and
 * BEFORE the JSON body parser so the request body streams through untouched; it
 * authenticates via the opaque `lgw:<target>[:<slot>]` token (not the app's
 * local token, which the agent CLI doesn't have), resolves the current node for
 * that target at REQUEST time (so switching the active node takes effect on the
 * next request), fails over to same-target siblings on a retryable upstream
 * error, and is bound to 127.0.0.1 only.
 */
import express from 'express';

import { isCompactionEnabled, isGatewayEnabled } from './gateway-config.js';
import { compactRequestBody, recordCompaction } from './gateway-compaction.js';
import { buildUpstreamHeaders, gatewayInternals, meterFromResponse, resolveUpstreamChain, type ResolvedUpstream } from './gateway.service.js';

const router = express.Router();

function readRawBody(req: express.Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A retryable upstream failure — safe to fail over BEFORE any byte is streamed. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Join the upstream base with the incoming path without doubling `/v1`.
 * Providers are commonly stored as `https://relay.example/v1`, and the CLI asks
 * for `/v1/messages` — raw concatenation produced `/v1/v1/messages` (a 404 that
 * is not retryable, so every request through such a node failed while the app's
 * own health probe, which already collapses this, kept reporting it healthy).
 */
export function upstreamUrl(baseUrl: string, requestUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/v1$/i.test(base) && /^\/v1(\/|$)/i.test(requestUrl)) return `${base}${requestUrl.slice(3)}`;
  return `${base}${requestUrl}`;
}

// Metering reads a bounded copy of the body. Keep a HEAD and a TAIL slice: the
// token totals live in the final `message_delta` of an SSE stream, so a
// head-only cap silently metered long responses at ~1 output token.
const METER_HEAD_BYTES = 256_000;
const METER_TAIL_BYTES = 64_000;

/** Faithfully stream an upstream response back + tee-meter it. */
async function streamAndMeter(res: express.Response, upstreamResponse: Response, providerName: string, signal: AbortSignal): Promise<void> {
  res.status(upstreamResponse.status);
  upstreamResponse.headers.forEach((value, key) => {
    if (!gatewayInternals.STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
  });
  if (!upstreamResponse.body) {
    const text = await upstreamResponse.text().catch(() => '');
    res.send(text);
    meterFromResponse(providerName, text, upstreamResponse.status);
    return;
  }
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let head = '';
  let tail = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      res.write(Buffer.from(value));
      const chunk = decoder.decode(value, { stream: true });
      if (head.length < METER_HEAD_BYTES) head += chunk;
      else {
        tail += chunk;
        if (tail.length > METER_TAIL_BYTES) tail = tail.slice(-METER_TAIL_BYTES);
      }
      // The client went away: stop pulling (and paying for) the generation.
      if (signal.aborted) {
        await reader.cancel().catch(() => { /* already gone */ });
        break;
      }
    }
  } catch { /* client disconnect / upstream abort — end below */ }
  res.end();
  meterFromResponse(providerName, tail ? `${head}\n${tail}` : head, upstreamResponse.status);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

router.all(/.*/, async (req, res) => {
  // Loopback only: the gateway holds real upstream keys and must never be
  // reachable off-box, regardless of how the server socket was bound.
  if (!LOOPBACK.has(req.socket.remoteAddress || '')) {
    res.status(403).json({ error: { type: 'forbidden', message: 'Gateway is loopback-only.' } });
    return;
  }
  if (!isGatewayEnabled()) {
    res.status(503).json({ error: { type: 'gateway_disabled', message: 'Leoapi gateway is off.' } });
    return;
  }
  // Express 4 does not adopt a returned promise, so an unhandled rejection here
  // would take the whole server down under Node's default policy rather than
  // failing this one request. Resolving the store touches disk and decrypts
  // keys, both of which can throw.
  let chain: ResolvedUpstream[];
  try {
    chain = await resolveUpstreamChain(req.headers);
  } catch (error) {
    res.status(500).json({ error: { type: 'gateway_error', message: error instanceof Error ? error.message : 'Could not resolve an upstream.' } });
    return;
  }
  if (chain.length === 0) {
    res.status(401).json({ error: { type: 'authentication_error', message: 'Unknown or missing Leoapi gateway token.' } });
    return;
  }

  let body: Buffer;
  try {
    body = await readRawBody(req);
  } catch {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'Could not read request body.' } });
    return;
  }

  // Opt-in context compaction: only for a Messages POST, only when on. The
  // helper fails open (returns null) on any shape it can't confidently rewrite,
  // so a non-Messages or malformed body forwards untouched.
  if (isCompactionEnabled() && req.method === 'POST' && /\/v1\/messages\/?$/.test(req.url.split('?')[0])) {
    const compacted = compactRequestBody(body);
    if (compacted) {
      body = compacted.body;
      recordCompaction(compacted.stats);
    }
  }

  // Try the primary node, then fail over to same-target siblings on a retryable
  // upstream error (429 / 5xx / network) — but only BEFORE any byte is streamed,
  // so a client never sees a half-response from two nodes. Each attempt is
  // metered. If every node fails, fail closed with the last real error.
  const upstreamHeaders = buildUpstreamHeaders(req.headers, '');
  // If the user aborts (Ctrl-C in the CLI), abort the upstream too — otherwise
  // the gateway kept pulling, and paying for, a generation nobody would read.
  const abort = new AbortController();
  req.on('close', () => abort.abort());
  for (let i = 0; i < chain.length; i += 1) {
    const upstream = chain[i];
    const isLast = i === chain.length - 1;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamUrl(upstream.baseUrl, req.url), {
        method: req.method,
        headers: { ...upstreamHeaders, 'x-api-key': upstream.apiKey, authorization: `Bearer ${upstream.apiKey}` },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        signal: abort.signal,
      });
    } catch (error) {
      meterFromResponse(upstream.providerName, '', 502);
      if (!isLast) continue;
      res.status(502).json({ error: { type: 'upstream_error', message: error instanceof Error ? error.message : 'Upstream request failed.' } });
      return;
    }

    if (isRetryableStatus(upstreamResponse.status) && !isLast) {
      await upstreamResponse.body?.cancel().catch(() => { /* discard */ });
      meterFromResponse(upstream.providerName, '', upstreamResponse.status);
      continue;
    }

    await streamAndMeter(res, upstreamResponse, upstream.providerName, abort.signal);
    return;
  }
});

export default router;
