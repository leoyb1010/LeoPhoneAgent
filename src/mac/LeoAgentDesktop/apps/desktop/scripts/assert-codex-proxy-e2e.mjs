#!/usr/bin/env node
/**
 * 从 desktop log 校验 codex-proxy E2E 不变量。
 *
 * 用法：
 *   node apps/desktop/scripts/assert-codex-proxy-e2e.mjs \
 *     --log-dir apps/desktop/logs \
 *     --expect <thread-id>:<unique-sentinel> \
 *     --plain-thread <ordinary-codex-thread-id> \
 *     --body-dump apps/desktop/logs/codex-proxy-dumps
 *
 * 主要输入是 createMakerLogger('codex-proxy') 输出的 desktop log NDJSON 记录。
 * 可选的 --body-dump 路径只用于本地校验 transformed request dump，例如验证
 * sentinel 是否存在、是否重复。它可以是 JSON 文件目录、单个 JSON 文件，或包含
 * 以下任一结构的 NDJSON：
 *   { "threadId": "...", "body": { "instructions": "...", "input": [...] } }
 * or
 *   { "selectedThreadId": "...", "instructions": "...", "input": [...] }
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const out = {
    logDir: path.resolve('apps/desktop/logs'),
    threads: [],
    minThreads: 1,
    minHitsPerThread: 1,
    sentinel: '',
    bodyDump: '',
    expectations: [],
    plainThreads: [],
    forbidDeveloper: [],
    forbidBodyField: ['output_config'],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    switch (arg) {
      case '--log-dir':
        out.logDir = path.resolve(next());
        break;
      case '--thread':
        out.threads.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
        break;
      case '--min-threads':
        out.minThreads = Number(next());
        break;
      case '--min-hits-per-thread':
        out.minHitsPerThread = Number(next());
        break;
      case '--sentinel':
        out.sentinel = next();
        break;
      case '--expect':
        out.expectations.push(parseExpectation(next()));
        break;
      case '--plain-thread':
        out.plainThreads.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
        break;
      case '--forbid-developer':
        out.forbidDeveloper.push(next());
        break;
      case '--forbid-body-field':
        out.forbidBodyField.push(next());
        break;
      case '--body-dump':
        out.bodyDump = path.resolve(next());
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (out.expectations.length > 0) {
    out.minThreads = Math.max(out.minThreads, out.expectations.length);
  }
  if (!Number.isFinite(out.minThreads) || out.minThreads < 1) {
    throw new Error('--min-threads must be a positive number');
  }
  if (!Number.isFinite(out.minHitsPerThread) || out.minHitsPerThread < 1) {
    throw new Error('--min-hits-per-thread must be a positive number');
  }
  return out;
}

function parseExpectation(raw) {
  const colon = raw.indexOf(':');
  const equal = raw.indexOf('=');
  const sep = colon >= 0 ? colon : equal;
  if (sep <= 0 || sep >= raw.length - 1) {
    throw new Error('--expect must be formatted as <threadId>:<sentinel>');
  }
  return {
    threadId: raw.slice(0, sep).trim(),
    sentinel: raw.slice(sep + 1),
  };
}

function printHelp() {
  process.stdout.write(`Assert codex-proxy E2E logs.

Options:
  --log-dir <dir>             Desktop logs dir. Default: apps/desktop/logs
  --thread <id[,id...]>       Restrict assertions to these thread ids.
  --expect <id:sentinel>      Assert a transformed body for this thread contains only its sentinel.
                              Can be repeated for multi-session no-cross-contamination checks.
  --plain-thread <id[,id...]> Assert this ordinary codex thread has no orca worker contract in instructions.
  --min-threads <n>           Require at least n distinct selectedThreadId values. Default: 1
  --min-hits-per-thread <n>   Require at least n injection hits per selected thread. Default: 1
  --sentinel <text>           Back-compat single-sentinel assertion for selected transformed body dumps.
  --forbid-developer <text>   Extra marker that must not appear in input[] developer messages.
  --forbid-body-field <name>  Field name that must not appear anywhere in transformed bodies.
                              Default: output_config. Can be repeated.
  --body-dump <path>          Optional transformed request body dump file or directory.
`);
}

const warnings = [];

function warn(message) {
  warnings.push(message);
}

function walkFiles(root) {
  const files = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      warn(`cannot read directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  visit(root);
  return files;
}

function logFiles(logDir) {
  return walkFiles(logDir).filter((file) => {
    const base = path.basename(file);
    return (base.startsWith('agent-') || /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(base)) &&
      base.endsWith('.ndjson');
  });
}

function parseValue(raw) {
  const text = raw.trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

function parseInjectionFields(msg) {
  if (!msg.includes('event') || !msg.includes('codex_proxy_injection')) return null;
  const fields = {};
  for (const line of msg.split('\n')) {
    const match = /^\s*([A-Za-z0-9_]+)\s+:\s*([\s\S]*)$/.exec(line);
    if (!match) continue;
    fields[match[1]] = parseValue(match[2]);
  }
  return fields.event === 'codex_proxy_injection' ? fields : null;
}

function readInjectionEvents(logDir) {
  const events = [];
  for (const file of logFiles(logDir)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const scope = typeof record.scope === 'string' ? record.scope : '';
      const msg = typeof record.msg === 'string' ? record.msg : '';
      if (!/^codex-proxy(\/|$)/.test(scope)) continue;
      const fields = parseInjectionFields(msg);
      if (!fields) continue;
      events.push({
        file,
        ts: typeof record.ts === 'number' ? record.ts : 0,
        seq: typeof record.seq === 'number' ? record.seq : 0,
        ...fields,
      });
    }
  }
  events.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
  return events;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const idx = haystack.indexOf(needle, offset);
    if (idx < 0) return count;
    count += 1;
    offset = idx + needle.length;
  }
}

function readBodyDump(fileOrDir) {
  if (!fileOrDir) return [];
  let stat;
  try {
    stat = fs.statSync(fileOrDir);
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') {
      throw new Error(`body dump path not found: ${fileOrDir}`);
    }
    throw new Error(`body dump path is not readable: ${fileOrDir}`);
  }
  if (stat.isDirectory()) {
    return walkFiles(fileOrDir)
      .filter((file) => file.endsWith('.json') || file.endsWith('.ndjson'))
      .sort()
      .flatMap((file) => readBodyDumpFile(file));
  }
  return readBodyDumpFile(fileOrDir);
}

function readBodyDumpFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    warn(`cannot read body dump file ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  if (!raw) return [];

  const records = [];
  if (file.endsWith('.json')) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warn(`cannot parse JSON body dump file ${file}; skipping`);
      return [];
    }
    records.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  } else {
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      try {
        records.push(JSON.parse(line));
      } catch {
        warn(`cannot parse NDJSON body dump line in ${file}; skipping`);
      }
    }
  }

  return records.map((parsed, index) => normalizeBodyDumpRecord(parsed, file, index));
}

function normalizeBodyDumpRecord(parsed, file, index) {
  const body = parsed.body && typeof parsed.body === 'object' ? parsed.body : parsed;
  const threadId = parsed.threadId ?? parsed.selectedThreadId ?? body.threadId ?? body.selectedThreadId;
  return {
    index,
    file,
    threadId: typeof threadId === 'string' ? threadId : '',
    instructions: typeof body.instructions === 'string' ? body.instructions : '',
    input: Array.isArray(body.input) ? body.input : [],
    body,
  };
}

function containsField(value, fieldName) {
  if (value == null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsField(item, fieldName));
  if (Object.hasOwn(value, fieldName)) return true;
  return Object.values(value).some((item) => containsField(item, fieldName));
}

function fail(message) {
  throw new Error(message);
}

function selectedThreadIds(opts) {
  const ids = new Set(opts.threads);
  for (const expectation of opts.expectations) ids.add(expectation.threadId);
  for (const threadId of opts.plainThreads) ids.add(threadId);
  return [...ids];
}

function assertInjections(events, opts) {
  if (events.length === 0) fail(`No codex_proxy_injection events found under ${opts.logDir}`);
  const threadIds = selectedThreadIds(opts);
  const selected = threadIds.length > 0
    ? events.filter((event) => threadIds.includes(String(event.selectedThreadId ?? '')))
    : events;
  if (selected.length === 0) {
    fail(`No codex_proxy_injection events matched threads: ${threadIds.join(', ')}`);
  }

  const first = selected[0];
  if (first.selectedHeaderName !== 'thread-id') {
    fail(`First selected request used ${first.selectedHeaderName}; expected thread-id`);
  }
  if (first.registryHit !== true) {
    fail('First selected request did not hit registry');
  }
  if (first.appended !== true) {
    fail(`First selected request appended=${first.appended}; expected true`);
  }

  for (const event of selected) {
    if (event.registryHit !== true) {
      fail(`Registry miss for thread ${event.selectedThreadId ?? '<missing>'} in ${event.file}`);
    }
    if (event.appended !== true && event.alreadyPresent !== true) {
      fail(`Injection did not append or report alreadyPresent for thread ${event.selectedThreadId ?? '<missing>'} in ${event.file}`);
    }
  }

  const byThread = new Map();
  for (const event of selected) {
    const threadId = String(event.selectedThreadId ?? '');
    if (!threadId) fail(`Injection event missing selectedThreadId in ${event.file}`);
    byThread.set(threadId, (byThread.get(threadId) ?? 0) + 1);
  }
  if (byThread.size < opts.minThreads) {
    fail(`Expected at least ${opts.minThreads} distinct threads, got ${byThread.size}`);
  }
  for (const [threadId, count] of byThread) {
    if (count < opts.minHitsPerThread) {
      fail(`Thread ${threadId} has ${count} injection hit(s), expected at least ${opts.minHitsPerThread}`);
    }
  }
  return { selected, byThread };
}

function textContent(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textContent).join('\n');
  if (typeof value === 'object') return Object.values(value).map(textContent).join('\n');
  return '';
}

function developerMessages(input) {
  return input.filter((item) => item && typeof item === 'object' && item.role === 'developer');
}

function bodyLabel(body) {
  return `${body.file ?? '<memory>'}#${body.index} thread=${body.threadId || '<unknown>'}`;
}

function assertSentinelBodies(opts) {
  const hasExpectations = opts.expectations.length > 0;
  if (!opts.sentinel && !hasExpectations && opts.forbidDeveloper.length === 0 && opts.plainThreads.length === 0) {
    return { bodyCount: 0 };
  }
  if (!opts.bodyDump) {
    fail('sentinel / body assertions require --body-dump so transformed instructions can be inspected');
  }
  const bodies = readBodyDump(opts.bodyDump);
  const threadIds = selectedThreadIds(opts);
  const selected = threadIds.length > 0
    ? bodies.filter((body) => threadIds.includes(body.threadId))
    : bodies;
  if (selected.length === 0) {
    fail(`No transformed body dump records matched sentinel assertion (${opts.bodyDump})`);
  }

  for (const body of selected) {
    for (const fieldName of opts.forbidBodyField) {
      if (fieldName && containsField(body.body, fieldName)) {
        fail(`Forbidden body field "${fieldName}" appears in ${bodyLabel(body)}`);
      }
    }
  }

  const expectedSentinels = hasExpectations
    ? opts.expectations.map((expectation) => expectation.sentinel)
    : opts.sentinel ? [opts.sentinel] : [];
  const developerForbidden = [...new Set([...expectedSentinels, ...opts.forbidDeveloper])].filter(Boolean);

  for (const body of selected) {
    for (const message of developerMessages(body.input)) {
      const text = textContent(message);
      for (const marker of developerForbidden) {
        if (text.includes(marker)) {
          fail(`Developer input message contains forbidden marker "${marker}" in ${bodyLabel(body)}`);
        }
      }
    }
  }

  if (hasExpectations) {
    for (const expectation of opts.expectations) {
      const matching = selected.filter((body) => body.threadId === expectation.threadId);
      if (matching.length === 0) {
        fail(`No transformed body dump records matched expected thread ${expectation.threadId}`);
      }
      for (const body of matching) {
        const ownCount = countOccurrences(body.instructions, expectation.sentinel);
        if (ownCount !== 1) {
          fail(`Sentinel occurrence count for ${bodyLabel(body)}: ${ownCount}, expected 1`);
        }
        for (const other of opts.expectations) {
          if (other.threadId === expectation.threadId) continue;
          const otherCount = countOccurrences(body.instructions, other.sentinel);
          if (otherCount !== 0) {
            fail(`Cross-thread sentinel "${other.sentinel}" appeared ${otherCount} time(s) in ${bodyLabel(body)}`);
          }
        }
      }
    }
  } else if (opts.sentinel) {
    for (const body of selected) {
      const count = countOccurrences(body.instructions, opts.sentinel);
      if (count !== 1) {
        fail(`Sentinel occurrence count for ${bodyLabel(body)}: ${count}, expected 1`);
      }
    }
  }

  const plainMarkers = ['send_to_lead', 'worker_id', 'workerId'];
  for (const threadId of opts.plainThreads) {
    const matching = selected.filter((body) => body.threadId === threadId);
    if (matching.length === 0) fail(`No transformed body dump records matched plain thread ${threadId}`);
    for (const body of matching) {
      for (const marker of plainMarkers) {
        if (body.instructions.includes(marker)) {
          fail(`Plain codex thread ${threadId} instructions contain orca marker "${marker}" in ${bodyLabel(body)}`);
        }
      }
    }
  }
  return { bodyCount: selected.length };
}

export function runAssertions(opts) {
  const events = readInjectionEvents(opts.logDir);
  const injectionSummary = assertInjections(events, opts);
  const bodySummary = assertSentinelBodies(opts);
  return {
    events: injectionSummary.selected.length,
    threads: injectionSummary.byThread.size,
    bodies: bodySummary.bodyCount,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const summary = runAssertions(opts);
    if (warnings.length > 0) {
      process.stderr.write(`${warnings.map((message) => `[warn] ${message}`).join('\n')}\n`);
    }
    process.stdout.write(
      `codex-proxy E2E assertions passed: events=${summary.events}, threads=${summary.threads}, bodies=${summary.bodies}\n`,
    );
  } catch (err) {
    if (warnings.length > 0) {
      process.stderr.write(`${warnings.map((message) => `[warn] ${message}`).join('\n')}\n`);
    }
    process.stderr.write(`codex-proxy E2E assertions failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
