#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_APP_URL = 'http://localhost:5173';
const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const STATUS_FIXTURES = [
  { slug: 'xdt-e2e-review-pending', displayName: 'xdt-e2e-review-pending', status: 'pending', scanStatus: 'pending', label: '机审中' },
  { slug: 'xdt-e2e-review-scanning', displayName: 'xdt-e2e-review-scanning', status: 'scanning', scanStatus: 'scanning', label: '机审中' },
  { slug: 'xdt-e2e-review-quarantine', displayName: 'xdt-e2e-review-quarantine', status: 'quarantine', scanStatus: 'quarantine', label: '人工复核中' },
  { slug: 'xdt-e2e-review-rejected', displayName: 'xdt-e2e-review-rejected', status: 'rejected', scanStatus: 'rejected', label: '审核未通过' },
  { slug: 'xdt-e2e-review-published', displayName: 'xdt-e2e-review-published', status: 'published', scanStatus: 'pass', label: null, visibility: 'public' },
];
const ACTION_FIXTURES = {
  publish: { slug: 'xdt-e2e-action-publish', displayName: 'xdt-e2e-action-publish', status: 'published', scanStatus: 'pass', visibility: 'private' },
  delete: { slug: 'xdt-e2e-action-delete', displayName: 'xdt-e2e-action-delete', status: 'published', scanStatus: 'pass', visibility: 'private' },
  delist: { slug: 'xdt-e2e-action-delist', displayName: 'xdt-e2e-action-delist', status: 'published', scanStatus: 'pass', visibility: 'public' },
  reclaim: { slug: 'xdt-e2e-action-reclaim', displayName: 'xdt-e2e-action-reclaim', status: 'published', scanStatus: 'pass', visibility: 'shared' },
};
const TEAM_SHARED_FIXTURE = {
  slug: 'xdt-e2e-team-shared-reclaim',
  displayName: 'xdt-e2e-team-shared-reclaim',
  status: 'published',
  scanStatus: 'pass',
};
const NON_OWNER_FIXTURE = {
  slug: 'xdt-e2e-non-owner-clone',
  displayName: 'xdt-e2e-non-owner-clone',
  status: 'published',
  scanStatus: 'pass',
};
const ALL_FIXTURE_SLUGS = [
  ...STATUS_FIXTURES.map((fixture) => fixture.slug),
  ...Object.values(ACTION_FIXTURES).map((fixture) => fixture.slug),
  TEAM_SHARED_FIXTURE.slug,
  NON_OWNER_FIXTURE.slug,
];

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function usage() {
  return [
    'Usage: node scripts/skillhub-management-e2e.mjs [options]',
    '',
    'Options:',
    '  --app-url=http://localhost:5173',
    '  --cdp=http://127.0.0.1:9222',
    '  --email=dev@example.com',
    '  --hub-env=/path/to/skill-hub/.env',
    '  --screenshots-dir=/tmp/xdt-skillhub-management-e2e',
  ].join('\n');
}

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function sqlJson(value) {
  return sqlString(JSON.stringify(value));
}

function stableHash(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 10);
}

function normalizeUrl(base) {
  return base.replace(/\/$/, '');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function defaultHubEnvPath() {
  return path.resolve(process.cwd(), '../../../skill-hub/.env');
}

function defaultScreenshotsDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(os.tmpdir(), 'xdt-skillhub-management-e2e', stamp);
}

function mysqlConfig(hubEnvPath) {
  const env = parseDotEnv(hubEnvPath);
  return {
    host: process.env.MYSQL_HOST ?? env.MYSQL_HOST ?? '127.0.0.1',
    port: process.env.MYSQL_PORT ?? env.MYSQL_PORT ?? '3306',
    user: process.env.MYSQL_USER ?? env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DATABASE ?? env.MYSQL_DATABASE ?? 'xd_skill_hub',
  };
}

function runMysql(db, sql) {
  return execFileSync(
    'mysql',
    [
      '-h',
      db.host,
      '-P',
      String(db.port),
      '-u',
      db.user,
      '--batch',
      '--raw',
      '--skip-column-names',
      db.database,
      '-e',
      sql,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, MYSQL_PWD: db.password },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

function fixtureStatement({ slug, displayName, status, scanStatus, visibility, teamVar, publishedByVar }) {
  const description = `${displayName} fixture for xdt Skill Hub management E2E.`;
  const flags = status === 'rejected'
    ? [{ name: 'review', issues: [{ message: 'E2E 审核未通过原因' }] }]
    : status === 'quarantine'
      ? [{ name: 'review', issues: [{ message: 'E2E 人工复核中' }] }]
      : [];
  const score = status === 'published' ? 92 : 61;
  const resolvedVisibility = visibility ?? (teamVar === '@owner_team_id' ? 'private' : teamVar === '@other_team_id' ? 'public' : 'shared');

  return `
    INSERT INTO skills (
      slug, display_name, summary, description, team_id, category_id, latest_version,
      download_count, star_count, watch_count, scorecard, moderation_status,
      moderation_flags, visibility, source, source_url, deprecated
    )
    VALUES (
      ${sqlString(slug)}, ${sqlString(displayName)}, ${sqlString(description)}, ${sqlString(description)},
      ${teamVar}, @category_id, '0.1.0', 0, 0, 0,
      ${sqlJson({ overall: score, security: 'pass', docs: score, examples: true })},
      ${sqlString(status)}, ${sqlJson(flags)}, ${sqlString(resolvedVisibility)},
      'internal', NULL, 0
    )
    ON DUPLICATE KEY UPDATE
      display_name = VALUES(display_name),
      summary = VALUES(summary),
      description = VALUES(description),
      category_id = VALUES(category_id),
      latest_version = VALUES(latest_version),
      scorecard = VALUES(scorecard),
      moderation_status = VALUES(moderation_status),
      moderation_flags = VALUES(moderation_flags),
      visibility = VALUES(visibility),
      updated_at = CURRENT_TIMESTAMP;

    SET @skill_id = (
      SELECT id FROM skills
      WHERE slug = ${sqlString(slug)}
        AND team_id = ${teamVar}
      LIMIT 1
    );

    INSERT INTO skill_versions (
      skill_id, version, manifest, changelog, file_path, file_size, file_hash,
      preview_files, scan_status, scan_result, quality_score, published_by
    )
    VALUES (
      @skill_id,
      '0.1.0',
      ${sqlJson({
        name: slug,
        displayName,
        description,
        version: '0.1.0',
      })},
      'E2E fixture',
      ${sqlString(`skills/${slug}/0.1.0/sha256:${stableHash(slug).padEnd(64, '0')}.zip`)},
      128,
      ${sqlString(`sha256:${stableHash(`${slug}:zip`).padEnd(64, '0')}`)},
      ${sqlJson([
        { path: 'SKILL.md', size: 180, language: 'markdown', truncated: false },
        { path: 'README.md', size: 120, language: 'markdown', truncated: false },
      ])},
      ${sqlString(scanStatus)},
      ${sqlJson({ gates: flags, status: scanStatus })},
      ${score},
      ${publishedByVar}
    )
    ON DUPLICATE KEY UPDATE
      manifest = VALUES(manifest),
      changelog = VALUES(changelog),
      file_path = VALUES(file_path),
      file_size = VALUES(file_size),
      file_hash = VALUES(file_hash),
      preview_files = VALUES(preview_files),
      scan_status = VALUES(scan_status),
      scan_result = VALUES(scan_result),
      quality_score = VALUES(quality_score),
      published_by = VALUES(published_by);

    DELETE FROM skill_categories WHERE skill_id = @skill_id;
    INSERT INTO skill_categories (skill_id, category_id) VALUES (@skill_id, @category_id);

    DELETE FROM skill_version_preview_files WHERE version_id = (
      SELECT id FROM skill_versions WHERE skill_id = @skill_id AND version = '0.1.0' LIMIT 1
    );
    INSERT INTO skill_version_preview_files (version_id, path, size, language, truncated, content)
    SELECT id, 'SKILL.md', 180, 'markdown', 0,
      ${sqlString(`# ${displayName}\n\n${description}\n\n## When to use\n\n用于 E2E 验证 Skill 详情和文件目录。`)}
    FROM skill_versions WHERE skill_id = @skill_id AND version = '0.1.0' LIMIT 1;
    INSERT INTO skill_version_preview_files (version_id, path, size, language, truncated, content)
    SELECT id, 'README.md', 120, 'markdown', 0,
      ${sqlString(`# ${displayName} README\n\nE2E preview file.`)}
    FROM skill_versions WHERE skill_id = @skill_id AND version = '0.1.0' LIMIT 1;
  `;
}

function seedModerationFixtures(db, email) {
  const ownerHash = stableHash(email);
  const otherEmail = `xdt-e2e-non-owner-${ownerHash}@xd.local`;
  const sql = `
    SET @owner_email = ${sqlString(email)};
    SET @owner_name = 'XDT E2E Owner';
    SET @owner_sso = ${sqlString(`xdt_e2e_owner_${ownerHash}`)};
    SET @owner_personal_slug = ${sqlString(`xdt-e2e-owner-${ownerHash}`)};

    INSERT INTO users (sso_id, name, email)
    VALUES (@owner_sso, @owner_name, @owner_email)
    ON DUPLICATE KEY UPDATE email = VALUES(email);

    SET @owner_id = (SELECT id FROM users WHERE email = @owner_email LIMIT 1);

    INSERT IGNORE INTO teams (name, slug, type, user_id, created_by)
    VALUES (@owner_name, @owner_personal_slug, 'personal', @owner_id, @owner_id);

    SET @owner_team_id = (
      SELECT id FROM teams
      WHERE user_id = @owner_id AND type = 'personal'
      ORDER BY id ASC
      LIMIT 1
    );

    INSERT INTO teams (name, slug, type, user_id, created_by, source)
    VALUES ('XDT E2E Team', ${sqlString(`xdt-e2e-team-${ownerHash}`)}, 'org', NULL, @owner_id, 'e2e')
    ON DUPLICATE KEY UPDATE name = VALUES(name), created_by = VALUES(created_by), source = VALUES(source);

    SET @team_id = (SELECT id FROM teams WHERE slug = ${sqlString(`xdt-e2e-team-${ownerHash}`)} LIMIT 1);
    INSERT INTO team_members (team_id, user_id, role)
    VALUES (@team_id, @owner_id, 'admin')
    ON DUPLICATE KEY UPDATE role = VALUES(role);

    SET @other_email = ${sqlString(otherEmail)};
    INSERT INTO users (sso_id, name, email)
    VALUES (${sqlString(`xdt_e2e_other_${ownerHash}`)}, 'XDT E2E Other', @other_email)
    ON DUPLICATE KEY UPDATE name = VALUES(name);

    SET @other_id = (SELECT id FROM users WHERE email = @other_email LIMIT 1);
    INSERT IGNORE INTO teams (name, slug, type, user_id, created_by)
    VALUES ('XDT E2E Other', ${sqlString(`xdt-e2e-other-${ownerHash}`)}, 'personal', @other_id, @other_id);
    SET @other_team_id = (
      SELECT id FROM teams
      WHERE user_id = @other_id AND type = 'personal'
      ORDER BY id ASC
      LIMIT 1
    );

    SET @category_id = COALESCE(
      (SELECT id FROM categories WHERE slug = 'ci' LIMIT 1),
      (SELECT id FROM categories ORDER BY id ASC LIMIT 1)
    );

    DELETE FROM skills WHERE slug IN (${ALL_FIXTURE_SLUGS.map(sqlString).join(', ')});

    ${fixtureStatement({
      ...ACTION_FIXTURES.publish,
      teamVar: '@owner_team_id',
      publishedByVar: '@owner_id',
    })}

    ${fixtureStatement({
      ...ACTION_FIXTURES.delete,
      teamVar: '@owner_team_id',
      publishedByVar: '@owner_id',
    })}

    ${fixtureStatement({
      ...ACTION_FIXTURES.delist,
      teamVar: '@owner_team_id',
      publishedByVar: '@owner_id',
    })}

    ${fixtureStatement({
      ...ACTION_FIXTURES.reclaim,
      teamVar: '@team_id',
      publishedByVar: '@owner_id',
    })}

    ${STATUS_FIXTURES.map((fixture) => fixtureStatement({
      ...fixture,
      teamVar: '@owner_team_id',
      publishedByVar: '@owner_id',
    })).join('\n')}

    ${fixtureStatement({
      ...TEAM_SHARED_FIXTURE,
      teamVar: '@team_id',
      publishedByVar: '@owner_id',
    })}

    ${fixtureStatement({
      ...NON_OWNER_FIXTURE,
      teamVar: '@other_team_id',
      publishedByVar: '@other_id',
    })}
  `;

  runMysql(db, sql);
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.ws.close();
  }
}

async function connectCdp(cdpUrl) {
  const targets = await fetch(new URL('/json', cdpUrl)).then((res) => res.json());
  const target =
    targets.find((t) => t.type === 'page' && String(t.url ?? '').includes('localhost:5173') && t.webSocketDebuggerUrl) ??
    targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  assert(target, `No Electron page target found at ${cdpUrl}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const cdp = new CdpClient(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Input.setIgnoreInputEvents', { ignore: false });
  return cdp;
}

async function pageEval(cdp, fn, ...args) {
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? 'Runtime.evaluate failed');
  }
  return result.result.value;
}

async function navigate(cdp, url) {
  await cdp.send('Page.navigate', { url });
  await wait(500);
}

async function reloadPage(cdp) {
  await cdp.send('Page.reload', { ignoreCache: true });
  await wait(800);
}

async function bodyText(cdp) {
  return pageEval(cdp, () => document.body.innerText);
}

async function waitFor(cdp, description, predicate, timeoutMs = 10_000, ...args) {
  const start = Date.now();
  let lastValue;
  while (Date.now() - start < timeoutMs) {
    lastValue = await pageEval(cdp, predicate, ...args);
    if (lastValue) return lastValue;
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${description}. Last value: ${JSON.stringify(lastValue)}`);
}

async function waitForText(cdp, text, timeoutMs = 10_000) {
  return waitFor(
    cdp,
    `text "${text}"`,
    (needle) => document.body.innerText.includes(needle),
    timeoutMs,
    text,
  );
}

async function waitForTextGone(cdp, text, timeoutMs = 5_000) {
  return waitFor(
    cdp,
    `text "${text}" to disappear`,
    (needle) => !document.body.innerText.includes(needle),
    timeoutMs,
    text,
  );
}

async function waitForDialogClosed(cdp, timeoutMs = 5_000) {
  return waitFor(
    cdp,
    'visible confirmation dialog to close',
    () => {
      const isVisible = (node) => {
        if (node.closest('[data-state="closed"]')) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0';
      };
      // 详情浮窗本身是常驻的 aside[role="dialog"],不算"待关闭的确认弹窗"
      return !Array.from(document.querySelectorAll('[role="alertdialog"], [role="dialog"]:not(aside)')).some(isVisible);
    },
    timeoutMs,
  );
}

async function clickText(cdp, text) {
  const result = await pageEval(cdp, (needle) => {
    const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0';
    };
    const selectors = [
      'button',
      '[role="button"]',
      '[role="menuitem"]',
      'a',
      'input',
      'select',
      'textarea',
    ].join(',');
    const nodes = Array.from(document.querySelectorAll(selectors));
    const found = nodes.find((node) => {
      const disabled = node.disabled || node.getAttribute('aria-disabled') === 'true';
      if (disabled) return false;
      if (!isVisible(node)) return false;
      const text = normalize(node.textContent || node.value || node.getAttribute('aria-label'));
      return text.includes(needle);
    });
    if (!found) {
      return { ok: false, body: document.body.innerText.slice(0, 2000) };
    }
    // 浮层(Radix 菜单/弹窗)内的元素不用坐标点击:小窗口下 popper 碰撞翻转 /
    // 越界都会让坐标失效,直接在元素上派发 pointer 事件序列触发 onSelect/onClick
    const inOverlay = Boolean(found.closest('[data-radix-popper-content-wrapper], [role="menu"], [role="dialog"]'));
    if (inOverlay) {
      const opts = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' };
      found.dispatchEvent(new PointerEvent('pointermove', opts));
      found.dispatchEvent(new PointerEvent('pointerdown', opts));
      found.dispatchEvent(new PointerEvent('pointerup', opts));
      found.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return { ok: true, clicked: true, body: document.body.innerText.slice(0, 2000) };
    }
    found.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = found.getBoundingClientRect();
    return {
      ok: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      body: document.body.innerText.slice(0, 2000),
    };
  }, text);
  assert(result.ok, `Cannot click text "${text}". Body: ${result.body}`);
  if (result.clicked) {
    await wait(350);
    return;
  }
  assert(Number.isFinite(result.x) && Number.isFinite(result.y), `Cannot locate text "${text}" for mouse click.`);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: result.x,
    y: result.y,
    button: 'none',
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: result.x,
    y: result.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: result.x,
    y: result.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await wait(350);
}

async function clickCardAction(cdp, title, actionText) {
  // 列表数据加载/cardState 派生会触发重渲染,单次定位可能踩到空档,带重试
  let result = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    result = await locateCardAction(cdp, title, actionText);
    if (result.ok) break;
    await wait(500);
  }
  assert(result.ok, `Cannot click "${actionText}" on card "${title}". Body: ${result.body}`);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: result.x,
    y: result.y,
    button: 'none',
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: result.x,
    y: result.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: result.x,
    y: result.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await wait(350);
}

async function locateCardAction(cdp, title, actionText) {
  return pageEval(cdp, (skillTitle, buttonText) => {
    const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0';
    };
    const titleNode = Array.from(document.querySelectorAll('h3')).find((node) =>
      normalize(node.textContent) === skillTitle && isVisible(node)
    );
    const card = titleNode?.closest('.select-text');
    const button = card
      ? Array.from(card.querySelectorAll('button')).find((node) =>
        normalize(node.textContent).includes(buttonText) && isVisible(node) && !node.disabled
      )
      : null;
    if (!button) {
      return { ok: false, body: document.body.innerText.slice(0, 2000) };
    }
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    return {
      ok: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      body: document.body.innerText.slice(0, 2000),
    };
  }, title, actionText);
}

async function setMarketInfoFields(cdp, { displayName, description }) {
  const result = await pageEval(cdp, (nextDisplayName, nextDescription) => {
    const setValue = (node, value) => {
      const proto = node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      descriptor?.set?.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // 列表搜索框在浮窗后面仍然挂载,必须把字段查询收进编辑弹窗范围,
    // 否则 document.querySelector('input') 会拿到搜索框
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]:not(aside)')).at(-1);
    if (!dialog) {
      return { ok: false, body: 'edit dialog not open' };
    }
    const input = dialog.querySelector('input');
    const textarea = dialog.querySelector('textarea');
    if (!input || !textarea) {
      return { ok: false, body: String(dialog.textContent ?? '').slice(0, 2000) };
    }
    const nativeSelect = dialog.querySelector('select');
    if (nativeSelect) {
      return { ok: false, body: 'edit dialog should not use native select' };
    }
    const categoryLabel = Array.from(dialog.querySelectorAll('label')).find((node) =>
      String(node.textContent ?? '').trim() === '分类');
    const categorySelectButton = categoryLabel?.parentElement?.querySelector('button');
    const category = String(categorySelectButton?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!category || category.includes('请选择分类')) {
      return { ok: false, body: String(dialog.textContent ?? '').slice(0, 2000) };
    }
    setValue(input, nextDisplayName);
    setValue(textarea, nextDescription);
    return { ok: true, category };
  }, displayName, description);
  assert(result.ok, `Cannot fill market info form. Body: ${result.body}`);
  await wait(350);
  return result.category;
}

async function assertMarketInfoCategoryIsPrefilled(cdp) {
  const result = await pageEval(cdp, () => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"]:not(aside)')).at(-1);
    if (!dialog) return { ok: false, reason: 'edit dialog not open' };
    if (dialog.querySelector('select')) return { ok: false, reason: 'native select is still rendered' };
    const categoryLabel = Array.from(dialog.querySelectorAll('label')).find((node) =>
      String(node.textContent ?? '').trim() === '分类');
    const button = categoryLabel?.parentElement?.querySelector('button');
    const label = String(button?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      ok: Boolean(label) && !label.includes('请选择分类'),
      reason: label || String(dialog.textContent ?? '').slice(0, 1000),
      label,
    };
  });
  assert(result.ok, `Category should be prefilled with custom select. ${result.reason}`);
  return result.label;
}

async function selectMineFilter(cdp) {
  const result = await pageEval(cdp, (needle) => {
    const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const button = Array.from(document.querySelectorAll('button')).find((node) =>
      normalize(node.textContent) === needle
    );
    if (!button) {
      return { ok: false, body: document.body.innerText.slice(0, 2000) };
    }
    button.click();
    return { ok: true };
  }, '我的发布');
  assert(result.ok, `Cannot select 我的发布 filter. Body: ${result.body}`);
  await waitFor(
    cdp,
    '我的发布 filter to become active',
    (needle) => Array.from(document.querySelectorAll('button')).some((node) =>
      String(node.textContent ?? '').replace(/\s+/g, ' ').trim() === needle &&
      node.getAttribute('aria-pressed') === 'true'
    ),
    5_000,
    '我的发布',
  );
}

async function waitForCardTitle(cdp, title, timeoutMs = 10_000) {
  return waitFor(
    cdp,
    `card "${title}"`,
    (skillTitle) => {
      const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll('h3')).some((node) =>
        normalize(node.textContent) === skillTitle);
    },
    timeoutMs,
    title,
  );
}

/** 点卡片「管理」直到菜单真的展开(列表重排会让坐标点击偶发落空) */
async function openCardManageMenu(cdp, title) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await clickCardAction(cdp, title, '管理');
    await wait(400);
    const open = await pageEval(cdp, () =>
      Array.from(document.querySelectorAll('[role="menuitem"]')).some((node) =>
        String(node.textContent ?? '').includes('编辑信息')));
    if (open) return;
    await pressEscape(cdp);
    await wait(300);
  }
  throw new Error(`Cannot open card manage menu for "${title}"`);
}

async function openMineSkillDetail(cdp, appUrl, fixture) {
  await navigate(cdp, `${appUrl}/#/skillhub/market`);
  await waitForText(cdp, '我的发布');
  await selectMineFilter(cdp);
  await waitForCardTitle(cdp, fixture.displayName);
  // 全屏详情页已移除:点卡片本体打开详情浮窗。
  // 先 ESC 关掉可能残留的上一个浮窗(同 URL hash 导航不重置页面状态)。
  await pressEscape(cdp);
  await clickCardTitle(cdp, fixture.displayName);
  await waitForPanel(cdp, fixture.displayName);
}

/** 点卡片本体(标题区域)打开详情浮窗。
 *  hash 导航到相同 URL 不会重置页面,上一个浮窗可能仍开着挡住坐标,
 *  所以用 JS 事件派发(冒泡到卡片 onClick),不依赖坐标命中。 */
async function clickCardTitle(cdp, title) {
  let result = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    result = await pageEval(cdp, (skillTitle) => {
      const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
      const heading = Array.from(document.querySelectorAll('h3')).find((node) =>
        normalize(node.textContent) === skillTitle);
      if (!heading) return { ok: false, body: document.body.innerText.slice(0, 2000) };
      const rect = heading.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return { ok: false, body: 'heading not visible' };
      const opts = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' };
      heading.dispatchEvent(new PointerEvent('pointermove', opts));
      heading.dispatchEvent(new PointerEvent('pointerdown', opts));
      heading.dispatchEvent(new PointerEvent('pointerup', opts));
      heading.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return { ok: true };
    }, title);
    if (result.ok) break;
    await wait(500);
  }
  assert(result.ok, `Cannot locate card "${title}". Body: ${result.body}`);
  await wait(350);
}

/** 等详情浮窗打开且标题就位 */
async function waitForPanel(cdp, title, timeoutMs = 10_000) {
  return waitFor(
    cdp,
    `preview panel "${title}"`,
    (needle) => {
      const panel = document.querySelector('aside[role="dialog"]');
      return Boolean(panel) && String(panel.textContent ?? '').includes(needle);
    },
    timeoutMs,
    title,
  );
}

/** 详情浮窗内的文本(避免取到浮窗背后的卡片列表) */
async function panelText(cdp) {
  return pageEval(cdp, () => String(document.querySelector('aside[role="dialog"]')?.textContent ?? ''));
}

/** 在详情浮窗范围内点击按钮(浮窗背后的卡片可能有同名「管理」按钮) */
async function clickPanelText(cdp, text) {
  const result = await pageEval(cdp, (needle) => {
    const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const scope = document.querySelector('aside[role="dialog"]');
    if (!scope) return { ok: false, body: 'panel not open' };
    const found = Array.from(scope.querySelectorAll('button, [role="button"]')).find((node) => {
      const disabled = node.disabled || node.getAttribute('aria-disabled') === 'true';
      return !disabled && normalize(node.textContent || node.getAttribute('aria-label')).includes(needle);
    });
    if (!found) return { ok: false, body: String(scope.textContent ?? '').slice(0, 2000) };
    const opts = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' };
    found.dispatchEvent(new PointerEvent('pointermove', opts));
    found.dispatchEvent(new PointerEvent('pointerdown', opts));
    found.dispatchEvent(new PointerEvent('pointerup', opts));
    found.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    return { ok: true };
  }, text);
  assert(result.ok, `Cannot click "${text}" in preview panel. ${result.body}`);
  await wait(350);
}

/** 切换可见性过滤 chip(可获取/全部/我的发布) */
async function selectVisibilityFilter(cdp, label) {
  const result = await pageEval(cdp, (needle) => {
    const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const button = Array.from(document.querySelectorAll('button')).find((node) =>
      normalize(node.textContent) === needle);
    if (!button) return { ok: false, body: document.body.innerText.slice(0, 2000) };
    button.click();
    return { ok: true };
  }, label);
  assert(result.ok, `Cannot select ${label} filter. Body: ${result.body}`);
  await waitFor(
    cdp,
    `${label} filter to become active`,
    (needle) => Array.from(document.querySelectorAll('button')).some((node) =>
      String(node.textContent ?? '').replace(/\s+/g, ' ').trim() === needle &&
      node.getAttribute('aria-pressed') === 'true'),
    5_000,
    label,
  );
}

/** 详情页 header 的菜单触发按钮文本是「管理」,精确匹配避免误中 README 正文 */
async function waitForExactButton(cdp, label, timeoutMs = 10_000) {
  return waitFor(
    cdp,
    `button "${label}"`,
    (needle) => {
      const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll('button, [role="button"]'))
        .some((node) => normalize(node.textContent) === needle);
    },
    timeoutMs,
    label,
  );
}

async function assertNoExactButton(cdp, label) {
  const found = await pageEval(cdp, (needle) => {
    const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('button, [role="button"]'))
      .some((node) => normalize(node.textContent) === needle);
  }, label);
  assert(!found, `Expected no button with exact text "${label}".`);
}

async function pressEscape(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(300);
}

async function openMarketManagementMenu(cdp, expectedMenuText) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // 浮窗背后的卡片也有「管理」按钮,必须在浮窗范围内点
    await clickPanelText(cdp, '管理');
    await wait(500);
    if ((await bodyText(cdp)).includes(expectedMenuText)) return;
    await pressEscape(cdp);
  }
  const text = await bodyText(cdp);
  throw new Error(`Cannot open 管理 menu with "${expectedMenuText}". Body: ${text.slice(0, 2000)}`);
}

/** 断言当前打开的菜单里某项是禁用态(审核中禁改可见性) */
async function assertMenuItemDisabled(cdp, label) {
  const result = await pageEval(cdp, (needle) => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
    const item = items.find((node) => String(node.textContent ?? '').includes(needle));
    if (!item) return { ok: false, reason: 'menu item not found' };
    const disabled = item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('data-disabled');
    return { ok: disabled, reason: disabled ? '' : 'menu item is enabled' };
  }, label);
  assert(result.ok, `Menu item "${label}" should be disabled: ${result.reason}`);
}

async function screenshot(cdp, screenshotsDir, name, evidence) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const file = path.join(screenshotsDir, `${String(evidence.length + 1).padStart(2, '0')}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  evidence.push(file);
  console.log(`SCREENSHOT ${file}`);
  return file;
}

async function currentEmail(cdp, explicitEmail) {
  if (explicitEmail) return explicitEmail;
  const auth = await pageEval(cdp, async () => {
    const result = await window.electronAPI.authInitialize();
    return {
      isAuthenticated: result.isAuthenticated,
      email: result.user?.email ?? null,
    };
  });
  if (auth?.email) return auth.email;
  throw new Error('Cannot determine current user email. Pass --email=<email>.');
}

async function listMine(cdp) {
  const response = await pageEval(cdp, async () => {
    const res = await window.electronAPI.skillhub.listMarket({ mine: true, limit: 200, sort: 'latest' });
    return {
      success: res.success,
      error: res.error,
      items: (res.items ?? []).map((item) => ({
        name: item.name,
        displayName: item.displayName,
        isMine: item.isMine,
        visibility: item.visibility,
        publishedVisibility: item.publishedVisibility,
        ownerType: item.ownerType,
        moderationStatus: item.moderationStatus,
      })),
    };
  });
  assert(response.success, `listMarket(mine) failed: ${response.error}`);
  return response.items;
}

async function waitForPublishedVisibility(cdp, slug, expectedVisibility) {
  return waitFor(
    cdp,
    `${slug} published visibility ${expectedVisibility}`,
    async (skillSlug, visibility) => {
      const res = await window.electronAPI.skillhub.info(skillSlug);
      return res.success && res.info?.publishedVisibility === visibility;
    },
    10_000,
    slug,
    expectedVisibility,
  );
}

async function waitForSkillDeleted(cdp, slug) {
  return waitFor(
    cdp,
    `${slug} to be deleted`,
    async (skillSlug) => {
      const res = await window.electronAPI.skillhub.info(skillSlug);
      return !res.success || res.deleted === true;
    },
    10_000,
    slug,
  );
}

async function waitForMarketInfo(cdp, slug, expected) {
  return waitFor(
    cdp,
    `${slug} market info readback`,
    async (skillSlug, fields) => {
      const res = await window.electronAPI.skillhub.info(skillSlug);
      if (!res.success || !res.info) return false;
      return res.info.displayName === fields.displayName &&
        res.info.description === fields.description &&
        (!fields.category || res.info.categories?.includes(fields.category));
    },
    10_000,
    slug,
    expected,
  );
}

async function assertSeededFixturesVisible(cdp) {
  const items = await listMine(cdp);
  const byName = new Map(items.map((item) => [item.name, item]));
  for (const fixture of STATUS_FIXTURES) {
    const item = byName.get(fixture.slug);
    assert(item, `Missing fixture in mine list: ${fixture.slug}`);
    assert(item.moderationStatus === fixture.status, `${fixture.slug} status expected ${fixture.status}, got ${item.moderationStatus}`);
    if (fixture.visibility) {
      assert(item.publishedVisibility === fixture.visibility, `${fixture.slug} visibility expected ${fixture.visibility}, got ${item.publishedVisibility}`);
    }
  }
  const teamItem = byName.get(TEAM_SHARED_FIXTURE.slug);
  assert(teamItem, `Missing team shared fixture in mine list: ${TEAM_SHARED_FIXTURE.slug}`);
  assert(teamItem.publishedVisibility === 'shared', `${TEAM_SHARED_FIXTURE.slug} should be shared`);
}

function assertTextHas(text, needle) {
  assert(text.includes(needle), `Expected page text to contain "${needle}".`);
}

function assertTextMissing(text, needle) {
  assert(!text.includes(needle), `Expected page text not to contain "${needle}".`);
}

async function assertDetailHasFileTree(cdp) {
  const text = await bodyText(cdp);
  assert(text.toLowerCase().includes('files'), 'Expected detail page to show the files panel.');
  assertTextHas(text, 'SKILL.md');
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const appUrl = normalizeUrl(args['app-url'] ?? DEFAULT_APP_URL);
  const cdpUrl = args.cdp ?? DEFAULT_CDP_URL;
  const hubEnvPath = path.resolve(args['hub-env'] ?? defaultHubEnvPath());
  const screenshotsDir = path.resolve(args['screenshots-dir'] ?? defaultScreenshotsDir());
  const evidence = [];
  let cdp;

  try {
    cdp = await connectCdp(cdpUrl);
    await navigate(cdp, `${appUrl}/#/skillhub/market`);
    await waitForText(cdp, '我的发布');
    const email = await currentEmail(cdp, args.email);
    console.log(`Using current user: ${email}`);

    seedModerationFixtures(mysqlConfig(hubEnvPath), email);
    await navigate(cdp, `${appUrl}/#/skillhub/market`);
    await reloadPage(cdp);
    await waitForText(cdp, '我的发布');
    await selectMineFilter(cdp);
    await waitForCardTitle(cdp, 'xdt-e2e-review-rejected');
    await assertSeededFixturesVisible(cdp);

    const listText = await bodyText(cdp);
    assertTextHas(listText, '机审中');
    assertTextHas(listText, '人工复核中');
    assertTextHas(listText, '审核未通过');
    assertTextHas(listText, '管理');
    assertTextMissing(listText, '审核通过/已上架');
    await screenshot(cdp, screenshotsDir, 'market-management-status-tags', evidence);

    await openMineSkillDetail(cdp, appUrl, STATUS_FIXTURES[0]);
    await waitForText(cdp, STATUS_FIXTURES[0].displayName);
    await waitForText(cdp, '机审中');
    await assertDetailHasFileTree(cdp);
    await screenshot(cdp, screenshotsDir, 'detail-machine-review-pending', evidence);

    await openMineSkillDetail(cdp, appUrl, STATUS_FIXTURES[1]);
    await waitForText(cdp, STATUS_FIXTURES[1].displayName);
    await waitForText(cdp, '机审中');
    await assertDetailHasFileTree(cdp);
    await screenshot(cdp, screenshotsDir, 'detail-machine-review-scanning', evidence);

    await openMineSkillDetail(cdp, appUrl, STATUS_FIXTURES[2]);
    await waitForText(cdp, STATUS_FIXTURES[2].displayName);
    await waitForText(cdp, '人工复核中');
    await assertDetailHasFileTree(cdp);
    await screenshot(cdp, screenshotsDir, 'detail-manual-review', evidence);

    await openMineSkillDetail(cdp, appUrl, STATUS_FIXTURES[3]);
    await waitForText(cdp, STATUS_FIXTURES[3].displayName);
    await waitForText(cdp, '审核未通过');
    await assertDetailHasFileTree(cdp);
    await screenshot(cdp, screenshotsDir, 'detail-review-rejected', evidence);

    await openMineSkillDetail(cdp, appUrl, STATUS_FIXTURES[4]);
    await waitForText(cdp, STATUS_FIXTURES[4].displayName);
    const publishedText = await panelText(cdp);
    assertTextMissing(publishedText, '机审中');
    assertTextMissing(publishedText, '人工复核中');
    assertTextMissing(publishedText, '审核未通过');
    await screenshot(cdp, screenshotsDir, 'detail-published-no-extra-status', evidence);

    // ── 卡片「管理」菜单:直接展开;机审中禁改可见性 ──────────
    await navigate(cdp, `${appUrl}/#/skillhub/market`);
    await waitForText(cdp, '我的发布');
    await selectMineFilter(cdp);
    await waitForCardTitle(cdp, STATUS_FIXTURES[0].displayName);
    await openCardManageMenu(cdp, STATUS_FIXTURES[0].displayName);
    const cardMenuText = await bodyText(cdp);
    assertTextHas(cardMenuText, '编辑信息');
    assertTextHas(cardMenuText, '管理可见性');
    assertTextHas(cardMenuText, 'Clone');
    assertTextHas(cardMenuText, '删除');
    assertTextMissing(cardMenuText, '上架到市场');
    assertTextMissing(cardMenuText, '收回到个人');
    assertTextMissing(cardMenuText, '转到团队库');
    assertTextMissing(cardMenuText, '移到团队库');
    await assertMenuItemDisabled(cdp, '管理可见性');
    await screenshot(cdp, screenshotsDir, 'menu-no-team-transfer', evidence);
    await pressEscape(cdp);

    // ── 详情页「管理」菜单(已发布,无审核锁) ─────────────────────────
    await openMineSkillDetail(cdp, appUrl, STATUS_FIXTURES[4]);
    await openMarketManagementMenu(cdp, '管理可见性');
    const detailMenuText = await bodyText(cdp);
    assertTextHas(detailMenuText, '编辑信息');
    assertTextHas(detailMenuText, '管理可见性');
    assertTextHas(detailMenuText, 'Clone');
    assertTextHas(detailMenuText, '删除');
    assertTextMissing(detailMenuText, '上架到市场');
    assertTextMissing(detailMenuText, '收回到个人');
    await screenshot(cdp, screenshotsDir, 'detail-manage-menu', evidence);
    await pressEscape(cdp);

    // ── 删除确认弹窗(取消路径) ──────────────────────────────────────────
    await openMineSkillDetail(cdp, appUrl, STATUS_FIXTURES[0]);
    await openMarketManagementMenu(cdp, '删除');
    await clickText(cdp, '删除');
    await waitForText(cdp, '确认删除');
    await screenshot(cdp, screenshotsDir, 'confirm-delete', evidence);
    await clickText(cdp, '取消');
    await waitForDialogClosed(cdp);

    // ── 编辑信息:弹窗化,关闭即留在原页;保存后 Hub 读回 ─────────────────
    await openMineSkillDetail(cdp, appUrl, STATUS_FIXTURES[0]);
    await openMarketManagementMenu(cdp, '编辑信息');
    await clickText(cdp, '编辑信息');
    await waitForText(cdp, '显示名');
    const editText = await bodyText(cdp);
    assertTextHas(editText, '显示名');
    assertTextHas(editText, '描述');
    assertTextHas(editText, '分类');
    assertTextMissing(editText, '归属团队');
    assertTextMissing(editText, '改市场信息');
    await assertMarketInfoCategoryIsPrefilled(cdp);
    await screenshot(cdp, screenshotsDir, 'edit-market-info', evidence);
    const editedMarketInfo = {
      displayName: 'xdt-e2e-review-pending-updated',
      description: 'Updated market info saved by xdt Skill Hub management E2E.',
    };
    await setMarketInfoFields(cdp, editedMarketInfo);
    await clickText(cdp, '保存');
    await waitForDialogClosed(cdp);
    await waitForText(cdp, editedMarketInfo.displayName);
    await waitForMarketInfo(cdp, STATUS_FIXTURES[0].slug, {
      ...editedMarketInfo,
    });
    await screenshot(cdp, screenshotsDir, 'edit-market-info-saved-readback', evidence);

    // ── 管理可见性:私有 → 公开(上架已并入弹窗) ─────────────────────────
    await openMineSkillDetail(cdp, appUrl, ACTION_FIXTURES.publish);
    await openMarketManagementMenu(cdp, '管理可见性');
    await clickText(cdp, '管理可见性');
    await waitForText(cdp, '仅自己使用');
    const visibilityDialogText = await bodyText(cdp);
    assertTextHas(visibilityDialogText, '公开');
    assertTextHas(visibilityDialogText, '给团队使用');
    assertTextHas(visibilityDialogText, '仅自己使用');
    assertTextHas(visibilityDialogText, '发布者');
    await screenshot(cdp, screenshotsDir, 'manage-visibility-dialog', evidence);
    await clickText(cdp, '公开');
    await clickText(cdp, '保存');
    await waitForDialogClosed(cdp);
    await waitForPublishedVisibility(cdp, ACTION_FIXTURES.publish.slug, 'public');
    await screenshot(cdp, screenshotsDir, 'action-publish-result', evidence);

    await openMineSkillDetail(cdp, appUrl, ACTION_FIXTURES.delete);
    await openMarketManagementMenu(cdp, '删除');
    await clickText(cdp, '删除');
    await waitForText(cdp, '确认删除');
    await clickText(cdp, '确认删除');
    await waitForSkillDeleted(cdp, ACTION_FIXTURES.delete.slug);
    await waitForText(cdp, '我的发布');
    await screenshot(cdp, screenshotsDir, 'action-delete-result', evidence);

    // ── 管理可见性:公开 → 仅自己使用(下架已并入弹窗) ───────────────────
    await openMineSkillDetail(cdp, appUrl, ACTION_FIXTURES.delist);
    await openMarketManagementMenu(cdp, '管理可见性');
    await clickText(cdp, '管理可见性');
    await waitForText(cdp, '仅自己使用');
    await clickText(cdp, '仅自己使用');
    await clickText(cdp, '保存');
    await waitForDialogClosed(cdp);
    await waitForPublishedVisibility(cdp, ACTION_FIXTURES.delist.slug, 'private');
    await screenshot(cdp, screenshotsDir, 'action-delist-result', evidence);

    // ── 管理可见性:团队归属 → 仅自己使用(收回到个人已并入弹窗,带红色影响提示) ──
    await openMineSkillDetail(cdp, appUrl, ACTION_FIXTURES.reclaim);
    await openMarketManagementMenu(cdp, '管理可见性');
    await clickText(cdp, '管理可见性');
    await waitForText(cdp, '仅自己使用');
    await clickText(cdp, '仅自己使用');
    await waitForText(cdp, '团队将看不到这个 Skill');
    await screenshot(cdp, screenshotsDir, 'confirm-reclaim-to-personal', evidence);
    await clickText(cdp, '保存');
    await waitForDialogClosed(cdp);
    await waitForPublishedVisibility(cdp, ACTION_FIXTURES.reclaim.slug, 'private');
    await screenshot(cdp, screenshotsDir, 'action-reclaim-result', evidence);

    // ── 团队归属 + 发布者改个人:需先选可见对象(audience-required 守门) ──
    await openMineSkillDetail(cdp, appUrl, TEAM_SHARED_FIXTURE);
    await openMarketManagementMenu(cdp, '管理可见性');
    await clickText(cdp, '管理可见性');
    await waitForText(cdp, '仅自己使用');
    await clickText(cdp, '个人');
    await waitForText(cdp, '请选择至少一个可见团队或部门');
    await screenshot(cdp, screenshotsDir, 'team-owner-to-personal-needs-audience', evidence);
    await pressEscape(cdp);
    await waitForDialogClosed(cdp);
    await waitForTextGone(cdp, '请选择至少一个可见团队或部门').catch(() => undefined);

    // 全屏详情路由已移除:owner 在「全部」tab 点卡片 → 浮窗只给 Clone
    await navigate(cdp, `${appUrl}/#/skillhub/market`);
    await waitForText(cdp, '我的发布');
    await selectVisibilityFilter(cdp, '全部');
    await waitForText(cdp, ACTION_FIXTURES.publish.displayName);
    await pressEscape(cdp);
    await clickCardTitle(cdp, ACTION_FIXTURES.publish.displayName);
    await waitForPanel(cdp, ACTION_FIXTURES.publish.displayName);
    await assertDetailHasFileTree(cdp);
    const ownerOutsideMineText = await panelText(cdp);
    assertTextHas(ownerOutsideMineText, 'Clone');
    await assertNoExactButton(cdp, '管理');
    await screenshot(cdp, screenshotsDir, 'owner-detail-outside-mine-clone', evidence);

    await navigate(cdp, `${appUrl}/#/skillhub/market`);
    await waitForText(cdp, '我的发布');
    await selectVisibilityFilter(cdp, '全部');
    await waitForText(cdp, NON_OWNER_FIXTURE.displayName);
    await pressEscape(cdp);
    await clickCardTitle(cdp, NON_OWNER_FIXTURE.displayName);
    await waitForPanel(cdp, NON_OWNER_FIXTURE.displayName);
    await assertDetailHasFileTree(cdp);
    const nonOwnerText = await panelText(cdp);
    assertTextHas(nonOwnerText, 'Clone');
    await assertNoExactButton(cdp, '管理');
    await screenshot(cdp, screenshotsDir, 'non-owner-detail-clone', evidence);

    const report = {
      ok: true,
      email,
      screenshotsDir,
      screenshots: evidence,
      fixtures: [
        ...STATUS_FIXTURES.map(({ slug, status, label, visibility }) => ({ slug, status, label, visibility })),
        { slug: ACTION_FIXTURES.publish.slug, status: 'published', label: 'manage-visibility private→public (publish)' },
        { slug: ACTION_FIXTURES.delete.slug, status: 'deleted', label: 'actual delete action' },
        { slug: ACTION_FIXTURES.delist.slug, status: 'published', label: 'manage-visibility public→private (delist)' },
        { slug: ACTION_FIXTURES.reclaim.slug, status: 'published', label: 'manage-visibility team→private (reclaim)' },
        { slug: TEAM_SHARED_FIXTURE.slug, status: 'published', label: 'audience-required guard' },
        { slug: ACTION_FIXTURES.publish.slug, status: 'published', label: 'owner outside mine entry Clone only' },
        { slug: NON_OWNER_FIXTURE.slug, status: 'published', label: 'Clone only' },
      ],
    };
    const reportPath = path.join(screenshotsDir, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`REPORT ${reportPath}`);
    console.log('skillhub-management-e2e passed');
  } catch (error) {
    if (cdp) {
      try {
        await screenshot(cdp, screenshotsDir, 'failure', evidence);
      } catch {
        // best-effort failure evidence only
      }
    }
    throw error;
  } finally {
    cdp?.close();
  }
}

run().catch((error) => {
  console.error(`skillhub-management-e2e failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
