#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
const mobileRoot = resolve(scriptDir, '..');

const forbiddenFiles = [
  'e2e/maestro/issue_confirm.yaml',
  'e2e/maestro/visual_session_issue.yaml',
];

const fileNameRules = [
  {
    root: 'e2e/visual-baselines',
    test: (filePath) => basename(filePath).startsWith('visual-session-issue.'),
    reason: 'Issue Confirm is desktop-only for mobile V1; do not add visual baselines for it.',
  },
];

const contentRules = [
  {
    roots: ['package.json', 'scripts', 'e2e/maestro'],
    exclude: [
      'scripts/mobile-scope-guard.mjs',
    ],
    patterns: [
      'issue_confirm.yaml',
      'visual_session_issue',
      'visual-session-issue',
      'interaction.issue.',
    ],
    reason: 'Issue Confirm must not be part of mobile E2E flows, anchors, or visual screenshots.',
  },
  {
    roots: ['src'],
    exclude: [
      'src/__tests__/interactionModel.test.ts',
      'src/__tests__/remoteSessionStore.test.ts',
    ],
    patterns: [
      'IssueConfirmCard',
      'buildIssueConfirmDecision',
      'buildIssueConfirmReviewPresentation',
      'normalizeIssueConfirm',
      'interaction.issue.',
    ],
    reason: 'Mobile UI must not reintroduce the GitHub Issue confirmation form.',
  },
  {
    roots: ['app'],
    patterns: [
      'transcribeVoice(',
      'DEVICE_LINK_VOICE_TRANSCRIBE_CHANNEL',
      'device-link:voice:transcribe',
    ],
    reason: 'Mobile voice composer must use the realtime controller + managed Cindy voice service, not the legacy desktop transcription channel.',
  },
];

const failures = [];

for (const relativePath of forbiddenFiles) {
  const absolutePath = resolve(mobileRoot, relativePath);
  if (existsSync(absolutePath)) {
    failures.push({
      file: relativePath,
      reason: 'Issue Confirm has no mobile V1 Maestro flow.',
    });
  }
}

for (const rule of fileNameRules) {
  for (const filePath of walk(resolve(mobileRoot, rule.root))) {
    if (rule.test(filePath)) {
      failures.push({
        file: toMobileRelative(filePath),
        reason: rule.reason,
      });
    }
  }
}

for (const rule of contentRules) {
  const excluded = new Set(rule.exclude ?? []);
  for (const root of rule.roots) {
    const absoluteRoot = resolve(mobileRoot, root);
    for (const filePath of walk(absoluteRoot)) {
      const relativePath = toMobileRelative(filePath);
      if (excluded.has(relativePath) || !isTextFile(filePath)) continue;
      const content = readFileSync(filePath, 'utf8');
      for (const pattern of rule.patterns) {
        if (content.includes(pattern)) {
          failures.push({
            file: relativePath,
            pattern,
            reason: rule.reason,
          });
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error('mobile-scope-guard failed: mobile V1 must not reintroduce the Issue Confirm form.');
  for (const failure of failures) {
    const pattern = failure.pattern ? ` pattern="${failure.pattern}"` : '';
    console.error(`- ${failure.file}${pattern}: ${failure.reason}`);
  }
  console.error('Allowed: shared protocol compatibility for issue_confirm and an unsupported desktop-only hint.');
  process.exit(1);
}

console.log('mobile-scope-guard passed');

function* walk(root) {
  if (!existsSync(root)) return;
  const stat = statSync(root);
  if (stat.isFile()) {
    yield root;
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === '.expo' || entry === '.git') continue;
    yield* walk(join(root, entry));
  }
}

function toMobileRelative(filePath) {
  return relative(mobileRoot, filePath).split('\\').join('/');
}

function isTextFile(filePath) {
  return /\.(json|mjs|js|ts|tsx|yaml|yml|md)$/.test(filePath);
}
