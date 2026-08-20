export class ProviderKind {
  key: string = '';
  title: string = '';
  color: string = '';
  mark: string = '';
  root: string = '';
  models: string[] = [];
}

export function providerKinds(): ProviderKind[] {
  return [
    kind('openAI', 'OpenAI / Compatible API', '#4CAF50', 'O', 'https://api.openai.com/v1',
      ['gpt-5.5', 'gpt-5.3-codex', 'gpt-5.2', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini']),
    kind('anthropic', 'Anthropic / Compatible API', '#AB47BC', 'A', 'https://api.anthropic.com/v1',
      ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5']),
    kind('gemini', 'Google Gemini', '#42A5F5', 'G',
      'https://generativelanguage.googleapis.com/v1beta',
      ['gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash',
        'gemini-2.5-flash-lite']),
    kind('xAI', 'xAI (Grok)', '#FF7043', 'X', 'https://api.x.ai/v1',
      ['grok-4.5', 'grok-4.3', 'grok-4-fast', 'grok-code-fast-1', 'grok-3-mini']),
    kind('kimiCode', 'Kimi Code', '#5C6BC0', 'K', 'https://api.kimi.com/coding/v1',
      ['kimi-k3', 'kimi-k2']),
    kind('openRouter', 'OpenRouter', '#00BCD4', 'R', 'https://openrouter.ai/api/v1',
      ['anthropic/claude-sonnet-4', 'google/gemini-2.5-flash', 'openai/gpt-4o',
        'meta-llama/llama-4-maverick']),
    kind('custom', '自定义 OpenAI 兼容', '#8E8E93', 'C', '', [])
  ];
}

export function keyHint(type: string): string {
  if (type === 'anthropic') {
    return 'sk-ant-...';
  }
  if (type === 'gemini') {
    return 'Gemini API Key...';
  }
  if (type === 'openRouter') {
    return 'sk-or-...';
  }
  if (type === 'xAI') {
    return 'xai-...';
  }
  if (type === 'kimiCode') {
    return 'sk-...';
  }
  return 'sk-...';
}

export function defaultAppendV1(type: string): boolean {
  return type !== 'gemini';
}

export function kindByKey(key: string): ProviderKind {
  const rows = providerKinds();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].key === key) {
      return rows[i];
    }
  }
  return rows[rows.length - 1];
}

function kind(key: string, title: string, color: string, mark: string, root: string,
  models: string[]): ProviderKind {
  const row = new ProviderKind();
  row.key = key;
  row.title = title;
  row.color = color;
  row.mark = mark;
  row.root = root;
  row.models = models;
  return row;
}
