import {
  isLongComposerPaste,
  normalizeComposerDocument,
  pastedTextComposerNode,
  sanitizeComposerLinkLabel,
  sessionLinkComposerNode,
  type ComposerNode,
} from '@/session/composerDocument';
import {
  findMarkdownLabelStart,
  parseProjectDeepLinkUrl,
  parseSessionDeepLinkUrl,
  projectDisplayName,
  PROJECT_DEEP_LINK_RE_SOURCE,
  SESSION_DEEP_LINK_RE_SOURCE,
  shortSessionId,
  unescapeMarkdownLabelBrackets,
} from '@/session/sessionLinks';
import { MAX_PASTED_TEXT_CHARS } from '@/session/composerRichInputProtocol';

interface PasteCandidate {
  end: number;
  href: string;
  kind: 'project' | 'session';
  label: string | null;
  start: number;
}

const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * Convert one user-initiated plain-text paste into semantic composer nodes.
 * Long text wins over deep-link recognition so logs containing links stay one
 * compact pasted-text atom, matching the desktop composer.
 */
export function composerNodesForPlainTextPaste(text: string): ComposerNode[] {
  if (!text) return [];
  if (isLongComposerPaste(text)) return [pastedTextComposerNode(text)];

  const candidates = findDeepLinkCandidates(text);
  if (candidates.length === 0) return [{ type: 'text', text }];

  const nodes: ComposerNode[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    if (candidate.start > cursor) {
      nodes.push({ type: 'text', text: text.slice(cursor, candidate.start) });
    }
    const node = candidate.kind === 'session'
      ? sessionNodeForCandidate(candidate)
      : projectNodeForCandidate(candidate);
    if (node) nodes.push(node);
    else nodes.push({ type: 'text', text: text.slice(candidate.start, candidate.end) });
    cursor = candidate.end;
  }
  if (cursor < text.length) nodes.push({ type: 'text', text: text.slice(cursor) });
  return normalizeComposerDocument({ version: 1, nodes }).nodes;
}

/** Apply the native clipboard fallback limit before constructing Composer nodes. */
export function composerNodesForBoundedPlainTextPaste(text: string): ComposerNode[] | null {
  if (text.length > MAX_PASTED_TEXT_CHARS) return null;
  return composerNodesForPlainTextPaste(text);
}

function findDeepLinkCandidates(text: string): PasteCandidate[] {
  const candidates: PasteCandidate[] = [];
  const markdownClose = new RegExp(
    `\\]\\((?:(${SESSION_DEEP_LINK_RE_SOURCE})|(${PROJECT_DEEP_LINK_RE_SOURCE}))\\)`,
    'g',
  );
  let match: RegExpExecArray | null;
  while ((match = markdownClose.exec(text)) !== null) {
    const href = match[1] ?? match[2];
    const kind = match[1] !== undefined ? 'session' : 'project';
    if (!isValidTarget(kind, href)) continue;
    const labelStart = findMarkdownLabelStart(text, match.index);
    if (labelStart < 0) continue;
    const rawLabel = unescapeMarkdownLabelBrackets(
      text.slice(labelStart + 1, match.index),
    ).trim();
    candidates.push({
      end: match.index + match[0].length,
      href,
      kind,
      label: rawLabel && rawLabel !== href ? rawLabel : null,
      start: labelStart,
    });
  }

  const bare = new RegExp(
    `(${SESSION_DEEP_LINK_RE_SOURCE})|(${PROJECT_DEEP_LINK_RE_SOURCE})`,
    'g',
  );
  while ((match = bare.exec(text)) !== null) {
    const kind = match[1] !== undefined ? 'session' : 'project';
    const href = match[0].replace(TRAILING_PUNCTUATION, '');
    if (!isValidTarget(kind, href)) continue;
    candidates.push({
      end: match.index + href.length,
      href,
      kind,
      label: null,
      start: match.index,
    });
  }

  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  return candidates;
}

function isValidTarget(kind: PasteCandidate['kind'], href: string): boolean {
  return kind === 'session'
    ? parseSessionDeepLinkUrl(href) !== null
    : parseProjectDeepLinkUrl(href) !== null;
}

function sessionNodeForCandidate(candidate: PasteCandidate): ComposerNode | null {
  const target = parseSessionDeepLinkUrl(candidate.href);
  if (!target) return null;
  const explicitLabel = candidate.label
    ? sanitizeComposerLinkLabel(candidate.label)
    : '';
  if (target.messageClientId) {
    return sessionLinkComposerNode({
      href: candidate.href,
      label: shortSessionId(target.messageClientId),
      titled: false,
    });
  }
  return sessionLinkComposerNode({
    href: candidate.href,
    label: explicitLabel || shortSessionId(target.sessionId),
    titled: explicitLabel.length > 0,
  });
}

function projectNodeForCandidate(candidate: PasteCandidate): ComposerNode | null {
  const target = parseProjectDeepLinkUrl(candidate.href);
  if (!target) return null;
  const explicitLabel = candidate.label
    ? sanitizeComposerLinkLabel(candidate.label)
    : '';
  const label = explicitLabel || projectDisplayName(target.workingDir);
  const raw = explicitLabel
    ? `[${explicitLabel}](${candidate.href})`
    : candidate.href;
  return {
    type: 'mention',
    kind: 'project',
    label,
    raw,
    href: candidate.href,
    workingDir: target.workingDir,
  };
}
