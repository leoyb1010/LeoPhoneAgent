import { queryClaudeSDK, spawnCursor } from '../providers/index.js';

type CommitMessageProvider = 'claude' | 'cursor';
type AnyRecord = Record<string, any>;

function collectWriterText(payload: unknown): string {
  const parsed = payload && typeof payload === 'object' ? payload as AnyRecord : null;
  if (!parsed) return '';
  if (parsed.type === 'claude-response' && parsed.data) {
    const message = parsed.data.message || parsed.data;
    if (Array.isArray(message.content)) {
      return message.content
        .filter((item: AnyRecord) => item?.type === 'text' && typeof item.text === 'string')
        .map((item: AnyRecord) => item.text)
        .join('');
    }
  }
  if (parsed.type === 'cursor-output' && typeof parsed.output === 'string') return parsed.output;
  if (parsed.type === 'text' && typeof parsed.text === 'string') return parsed.text;
  return '';
}

export async function generateCommitMessageWithAI(
  files: string[],
  diffContext: string,
  provider: CommitMessageProvider,
  projectPath: string,
): Promise<string> {
  const prompt = `Generate a conventional commit message for these changes.

REQUIREMENTS:
- Format: type(scope): subject
- Include body explaining what changed and why
- Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore
- Subject under 50 chars, body wrapped at 72 chars
- Focus on user-facing changes, not implementation details
- Consider what's being added AND removed
- Return ONLY the commit message (no markdown, explanations, or code blocks)

FILES CHANGED:
${files.map((file) => `- ${file}`).join('\n')}

DIFFS:
${diffContext.substring(0, 4000)}

Generate the commit message:`;

  try {
    let responseText = '';
    const writer = {
      send: (data: unknown) => {
        try {
          const payload = typeof data === 'string' ? JSON.parse(data) as unknown : data;
          responseText += collectWriterText(payload);
        } catch (error) {
          console.error('Error parsing commit-message writer data:', error);
        }
      },
      setSessionId: (_sessionId: string) => undefined,
    };

    if (provider === 'claude') {
      await queryClaudeSDK(prompt, { cwd: projectPath, permissionMode: 'bypassPermissions', model: 'sonnet' }, writer);
    } else {
      await spawnCursor(prompt, { cwd: projectPath, skipPermissions: true }, writer);
    }

    return cleanCommitMessage(responseText) || 'chore: update files';
  } catch (error) {
    console.error('Error generating commit message with AI:', error);
    return `chore: update ${files.length} file${files.length !== 1 ? 's' : ''}`;
  }
}

export function cleanCommitMessage(text: string): string {
  if (!text?.trim()) return '';
  let cleaned = text.trim()
    .replace(/```[a-z]*\n/g, '')
    .replace(/```/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^["']|["']$/g, '')
    .replace(/\n{3,}/g, '\n\n');
  const conventionalCommitMatch = cleaned.match(/(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.+?\))?:.+/s);
  if (conventionalCommitMatch) cleaned = cleaned.substring(cleaned.indexOf(conventionalCommitMatch[0]));
  return cleaned.trim();
}
