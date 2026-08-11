import release1492 from '../../docs/RELEASE-1.49.2.md?raw';
import release1491 from '../../docs/RELEASE-1.49.1.md?raw';
import release1490 from '../../docs/RELEASE-1.49.0.md?raw';
import release1480 from '../../docs/RELEASE-1.48.0.md?raw';
import release1470 from '../../docs/RELEASE-1.47.0.md?raw';
import type { ReleaseInfo } from '../types/sharedTypes';

const RELEASES: Array<[string, string]> = [
  ['1.49.2', release1492],
  ['1.49.1', release1491],
  ['1.49.0', release1490],
  ['1.48.0', release1480],
  ['1.47.0', release1470],
];

function extractTitle(body: string, version: string): string {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || `leocodebox v${version}`;
}

export function releaseSummary(body: string): string {
  const lines = body.split('\n').map((line) => line.trim());
  return lines.find((line) => line && !line.startsWith('#') && !line.startsWith('-')) || '';
}

export const releaseHistory: ReleaseInfo[] = RELEASES.map(([version, body]) => ({
  version,
  title: extractTitle(body, version),
  body,
  summary: releaseSummary(body),
  htmlUrl: `https://github.com/leoyb1010/leocodebox/releases/tag/v${version}`,
  publishedAt: '',
}));
