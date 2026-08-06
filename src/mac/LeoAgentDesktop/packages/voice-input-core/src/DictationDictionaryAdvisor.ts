import type { TextModelClient } from './DictationRefiner';

export type DictationDictionaryTermType =
  | 'product_name'
  | 'project_name'
  | 'technical_term'
  | 'person_name'
  | 'team_name'
  | 'code_name'
  | 'phrase'
  | 'other';

export type DictationDictionaryLearningActionType =
  | 'add_candidate'
  | 'add_entry'
  | 'update_entry';

export type DictationDictionaryLearningConfidence = 'high' | 'medium' | 'low';

export type DictationDictionaryLearningAction = {
  action: DictationDictionaryLearningActionType;
  term: string;
  aliases: string[];
  type: DictationDictionaryTermType;
  confidence: DictationDictionaryLearningConfidence;
  reason?: string;
};

export type DictationDictionaryLearningEntryState = {
  term: string;
  source?: 'manual' | 'automatic';
  frequency?: number;
  aliases?: Array<{
    text: string;
    count?: number;
  }>;
};

export type DictationDictionaryLearningCandidateState = {
  term: string;
  evidenceCount?: number;
  aliases?: Array<{
    text: string;
    count?: number;
  }>;
};

export type DictationDictionaryLearningContext = {
  uiLanguage?: string;
  sourceLanguage?: string;
  activeApp?: string;
  selectionBefore?: string;
  selectedText?: string;
  selectionAfter?: string;
};

export type DictationDictionaryAdviceInput = {
  source?: 'in_app' | 'external_overlay';
  debug?: boolean;
  /**
   * Direct ASR output before refinement. Dictionary learning is still triggered
   * by the user's edit from beforeText to afterText, but this gives the advisor
   * the original misrecognition when refinement itself changed it first.
   */
  rawTranscriptText?: string;
  beforeText: string;
  afterText: string;
  context?: DictationDictionaryLearningContext;
  existingEntries?: DictationDictionaryLearningEntryState[];
  existingCandidates?: DictationDictionaryLearningCandidateState[];
};

export type DictationDictionaryAdviceResult = {
  actions: DictationDictionaryLearningAction[];
  ignoreReason?: string | null;
  elapsedMs: number;
};

export type DictationDictionaryAdviceSkipReason =
  | 'empty_text'
  | 'same_text'
  | 'formatting_only'
  | 'large_rewrite';

type DictationDictionaryAdvisorOptions = {
  client: TextModelClient;
  model: string;
  promptCacheScope?: string;
  systemPrompt?: string;
  promptVersion?: string;
  debug?: boolean;
};

type AdvisorResponse = {
  actions?: unknown;
  ignoreReason?: unknown;
};

const MAX_TEXT_CHARS = 2_000;
const MAX_CONTEXT_CHARS = 600;
const MAX_ENTRIES = 80;
const MAX_CANDIDATES = 80;
const MAX_ALIASES_PER_TERM = 5;
const MAX_ACTIONS = 3;
const MAX_TERM_CHARS = 120;
const MAX_DIRECT_REPLACEMENT_CHARS = 160;
const LARGE_REWRITE_MIN_TEXT_CHARS = 32;
const LARGE_REWRITE_CHANGED_RATIO = 0.65;

export const DEFAULT_DICTATION_DICTIONARY_ADVISOR_PROMPT_VERSION = 'dictation-dictionary-learning.zh.v3';

export const DEFAULT_DICTATION_DICTIONARY_ADVISOR_SYSTEM_PROMPT: string = `
你是语音输入的自动词典学习判断器。

你的任务不是润色文本、不是纠错、不是回答用户，而是根据用户在语音输入后对文本做出的手动修改，判断是否应该把某个词或短语加入“自动识别词典”。

你会收到：
- rawTranscriptText：可选，ASR 直接识别出的 refine 前文本。它可能比 beforeText 更接近真实误识别，也可能是 refine 改错前的原始证据。
- beforeText：语音输入粘贴或插入后的文本。
- afterText：用户手动修改后的文本。
- context：光标附近文本、当前应用和语言，只用于辅助理解。
- existingEntries：已经存在的正式词典项，包含词频和常见误识别 alias。
- existingCandidates：已经观察到但尚未正式加入的候选项，包含证据次数和 alias 次数。

判断目标：
- 找出用户是否把 ASR/refine 误识别的词，改成了更准确的专有名词、产品名、项目名、技术术语、人名、团队名、代码名或固定短语。
- 你要决定是直接写入正式词典，还是先写入候选，还是更新已有词条，还是忽略。

重要原则：
1. 只从 beforeText 和 afterText 的差异中学习，不要从 context 里凭空生成词条。
   rawTranscriptText 只能作为 alias 证据补充；如果用户没有通过 afterText 做出对应修改，不要只因为 rawTranscriptText 出现某个词就学习。
2. 不要输出普通改写、语气调整、标点变化、补字删字、同义改写。
3. 不要把常见词拆出来单独学习；如果用户修改的是一个完整短语，要学习完整短语。
4. 例如 beforeText 是“web coding”，afterText 是“Vibe Coding”，应该学习 term = “Vibe Coding”，alias = “web coding”，不要学习 “Vibe” / “web”。
5. 如果 rawTranscriptText 包含更原始的误识别写法，而 beforeText 是 refine 后的中间错误，也可以把 rawTranscriptText 中的误识别片段作为 alias。
6. 如果 afterText 中的正确写法包含大小写、空格、连字符、数字或品牌拼写，要保留原样。
7. existingEntries 和 existingCandidates 是重要参考：已有正式词条应 update_entry；已有候选且证据足够强可以 add_entry；证据还不够强但像术语纠错可以 add_candidate。
8. 如果不确定是否是稳定术语，输出空 actions。
9. 默认不要输出 reason 或 ignoreReason。debug=true 时，每个 action 必须输出 reason；如果 actions 为空，必须输出 ignoreReason，简要说明为什么忽略。

动作含义：
- add_candidate：这次像术语纠错，但还需要更多证据。
- add_entry：这次足够明确，或已有候选证据足够多，可以进入正式自动词典。
- update_entry：正确词已经在正式词典里，只需要增加词频和 alias 证据。

输出要求：
只返回严格 JSON，不要 Markdown，不要解释文本块。

正式 JSON：
{"actions":[{"action":"add_candidate","term":"正确词或短语","aliases":["被误识别成的词或短语"],"type":"product_name | project_name | technical_term | person_name | team_name | code_name | phrase | other","confidence":"high | medium"}]}

如果没有值得学习的内容：
{"actions":[]}

debug=true 时：
- 每个 action 必须输出 reason，简要说明为什么选择该 term、alias 和 action。
- 如果 actions 为空，必须输出 ignoreReason，例如“普通改写，不是稳定术语纠错”。
`.trim();

export class DictationDictionaryAdvisor {
  private readonly client: TextModelClient;
  private readonly model: string;
  private readonly promptCacheScope?: string;
  private readonly systemPrompt: string;
  private readonly promptVersion: string;
  private readonly debug: boolean;

  constructor(options: DictationDictionaryAdvisorOptions) {
    this.client = options.client;
    this.model = options.model;
    this.promptCacheScope = options.promptCacheScope;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_DICTATION_DICTIONARY_ADVISOR_SYSTEM_PROMPT;
    this.promptVersion = options.promptVersion ?? DEFAULT_DICTATION_DICTIONARY_ADVISOR_PROMPT_VERSION;
    this.debug = options.debug ?? false;
  }

  async advise(input: DictationDictionaryAdviceInput): Promise<DictationDictionaryAdviceResult> {
    const startedAt = performance.now();
    const request = normalizeAdviceInput(input, this.promptVersion, this.debug);
    const skipReason = getNormalizedAdviceSkipReason(request);
    if (skipReason) {
      return {
        actions: [],
        ignoreReason: this.debug ? skipReason : null,
        elapsedMs: performance.now() - startedAt,
      };
    }

    const response = await this.client.requestJson<AdvisorResponse>({
      model: this.model,
      schemaName: 'dictation_dictionary_learning',
      system: this.systemPrompt,
      promptCacheScope: this.promptCacheScope,
      user: request,
    });

    return {
      actions: normalizeAdvisorActions(
        response.actions,
        [request.beforeText, request.rawTranscriptText].filter(Boolean).join('\n'),
        request.afterText,
      ),
      ignoreReason: this.debug && typeof response.ignoreReason === 'string' ? response.ignoreReason : null,
      elapsedMs: performance.now() - startedAt,
    };
  }
}

export function getDictationDictionaryAdviceSkipReason(
  input: DictationDictionaryAdviceInput,
): DictationDictionaryAdviceSkipReason | null {
  const request = normalizeAdviceInput(input, DEFAULT_DICTATION_DICTIONARY_ADVISOR_PROMPT_VERSION, false);
  return getNormalizedAdviceSkipReason(request);
}

function normalizeAdviceInput(
  input: DictationDictionaryAdviceInput,
  promptVersion: string,
  debug: boolean,
): DictationDictionaryAdviceInput & { promptVersion: string } {
  return {
    promptVersion,
    debug,
    source: input.source === 'external_overlay' ? 'external_overlay' : 'in_app',
    rawTranscriptText: normalizeOptionalText(input.rawTranscriptText)?.slice(0, MAX_TEXT_CHARS),
    beforeText: normalizeText(input.beforeText).slice(0, MAX_TEXT_CHARS),
    afterText: normalizeText(input.afterText).slice(0, MAX_TEXT_CHARS),
    context: normalizeContext(input.context),
    existingEntries: normalizeEntryStates(input.existingEntries),
    existingCandidates: normalizeCandidateStates(input.existingCandidates),
  };
}

function normalizeContext(context: DictationDictionaryLearningContext | undefined): DictationDictionaryLearningContext {
  return {
    uiLanguage: normalizeOptionalText(context?.uiLanguage),
    sourceLanguage: normalizeOptionalText(context?.sourceLanguage),
    activeApp: normalizeOptionalText(context?.activeApp),
    selectionBefore: normalizeOptionalText(context?.selectionBefore)?.slice(-MAX_CONTEXT_CHARS),
    selectedText: normalizeOptionalText(context?.selectedText)?.slice(0, MAX_CONTEXT_CHARS),
    selectionAfter: normalizeOptionalText(context?.selectionAfter)?.slice(0, MAX_CONTEXT_CHARS),
  };
}

function getNormalizedAdviceSkipReason(
  input: Pick<DictationDictionaryAdviceInput, 'beforeText' | 'afterText'>,
): DictationDictionaryAdviceSkipReason | null {
  const beforeText = normalizeText(input.beforeText);
  const afterText = normalizeText(input.afterText);
  if (!beforeText || !afterText) return 'empty_text';
  if (beforeText === afterText) return 'same_text';
  if (sameIgnoringSentencePunctuation(beforeText, afterText)) return 'formatting_only';
  const changedSpan = findChangedSpan(beforeText, afterText);
  if (!changedSpan) return 'same_text';
  if (isLargeRewrite(beforeText, afterText, changedSpan)) return 'large_rewrite';
  return null;
}

function findChangedSpan(beforeText: string, afterText: string): { before: string; after: string } | null {
  let prefix = 0;
  const maxPrefix = Math.min(beforeText.length, afterText.length);
  while (prefix < maxPrefix && beforeText[prefix] === afterText[prefix]) prefix += 1;

  let beforeEnd = beforeText.length;
  let afterEnd = afterText.length;
  while (
    beforeEnd > prefix &&
    afterEnd > prefix &&
    beforeText[beforeEnd - 1] === afterText[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const before = beforeText.slice(prefix, beforeEnd);
  const after = afterText.slice(prefix, afterEnd);
  return before || after ? { before, after } : null;
}

function isLargeRewrite(
  beforeText: string,
  afterText: string,
  changedSpan: { before: string; after: string },
): boolean {
  const beforeContentChars = countContentChars(beforeText);
  const afterContentChars = countContentChars(afterText);
  const maxContentChars = Math.max(beforeContentChars, afterContentChars);
  const changedContentChars = Math.max(
    countContentChars(changedSpan.before),
    countContentChars(changedSpan.after),
  );

  if (changedContentChars > MAX_DIRECT_REPLACEMENT_CHARS) return true;
  if (maxContentChars < LARGE_REWRITE_MIN_TEXT_CHARS) return false;
  return changedContentChars / Math.max(1, maxContentChars) > LARGE_REWRITE_CHANGED_RATIO;
}

function countContentChars(text: string): number {
  return removeSentencePunctuation(text).replace(/\s+/g, '').length;
}

function sameIgnoringSentencePunctuation(beforeText: string, afterText: string): boolean {
  return removeSentencePunctuation(beforeText) === removeSentencePunctuation(afterText);
}

function removeSentencePunctuation(text: string): string {
  // Keep hyphen/underscore/slash/etc. because they are meaningful in model,
  // command, file, and product names. This skip gate is only for sentence
  // punctuation edits that cannot usefully teach the dictionary.
  return normalizeText(text).replace(/[，。！？、,.!?:：;；"'“”‘’`()[\]{}<>《》【】]/g, '');
}

function normalizeEntryStates(
  entries: DictationDictionaryLearningEntryState[] | undefined,
): DictationDictionaryLearningEntryState[] {
  return (entries ?? [])
    .flatMap((entry): DictationDictionaryLearningEntryState[] => {
      const term = normalizePhrase(entry.term);
      if (!term) return [];
      return [{
        term,
        source: entry.source === 'automatic' ? 'automatic' : 'manual',
        frequency: normalizePositiveInteger(entry.frequency),
        aliases: normalizeAliasStates(entry.aliases),
      }];
    })
    .slice(0, MAX_ENTRIES);
}

function normalizeCandidateStates(
  candidates: DictationDictionaryLearningCandidateState[] | undefined,
): DictationDictionaryLearningCandidateState[] {
  return (candidates ?? [])
    .flatMap((candidate): DictationDictionaryLearningCandidateState[] => {
      const term = normalizePhrase(candidate.term);
      if (!term) return [];
      return [{
        term,
        evidenceCount: normalizePositiveInteger(candidate.evidenceCount),
        aliases: normalizeAliasStates(candidate.aliases),
      }];
    })
    .slice(0, MAX_CANDIDATES);
}

function normalizeAliasStates(
  aliases: Array<{ text: string; count?: number }> | undefined,
): Array<{ text: string; count: number }> {
  const seen = new Set<string>();
  return (aliases ?? [])
    .map((alias) => {
      const text = normalizePhrase(alias.text);
      if (!text) return null;
      const key = normalizeLearningKey(text);
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        text,
        count: normalizePositiveInteger(alias.count),
      };
    })
    .filter((alias): alias is { text: string; count: number } => Boolean(alias))
    .slice(0, MAX_ALIASES_PER_TERM);
}

function normalizeAdvisorActions(
  value: unknown,
  beforeText: string,
  afterText: string,
): DictationDictionaryLearningAction[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const actions: DictationDictionaryLearningAction[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Partial<DictationDictionaryLearningAction>;
    const action = normalizeActionType(candidate.action);
    const confidence = normalizeConfidence(candidate.confidence);
    const term = normalizePhrase(candidate.term);
    if (!action || !confidence || confidence === 'low' || !term) continue;
    if (term.length > MAX_TERM_CHARS || !containsNormalized(afterText, term)) continue;
    const aliases = normalizeActionAliases(candidate.aliases, beforeText, term);
    if (aliases.length === 0) continue;
    const type = normalizeTermType(candidate.type);
    const key = `${action}:${normalizeLearningKey(term)}:${aliases.map(normalizeLearningKey).join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({
      action,
      term,
      aliases,
      type,
      confidence,
      reason: typeof candidate.reason === 'string' ? candidate.reason.trim().slice(0, 240) : undefined,
    });
    if (actions.length >= MAX_ACTIONS) break;
  }
  return actions;
}

function normalizeActionAliases(
  aliases: string[] | undefined,
  beforeText: string,
  term: string,
): string[] {
  if (!Array.isArray(aliases)) return [];
  const seen = new Set<string>();
  return aliases
    .map(normalizePhrase)
    .filter((alias) => {
      if (!alias || alias.length > MAX_TERM_CHARS) return false;
      if (sameNormalized(alias, term)) return false;
      if (!containsNormalized(beforeText, alias)) return false;
      const key = normalizeLearningKey(alias);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_ALIASES_PER_TERM);
}

function normalizeActionType(value: unknown): DictationDictionaryLearningActionType | null {
  return value === 'add_candidate' || value === 'add_entry' || value === 'update_entry'
    ? value
    : null;
}

function normalizeConfidence(value: unknown): DictationDictionaryLearningConfidence | null {
  return value === 'high' || value === 'medium' || value === 'low' ? value : null;
}

function normalizeTermType(value: unknown): DictationDictionaryTermType {
  return value === 'product_name' ||
    value === 'project_name' ||
    value === 'technical_term' ||
    value === 'person_name' ||
    value === 'team_name' ||
    value === 'code_name' ||
    value === 'phrase' ||
    value === 'other'
    ? value
    : 'other';
}

function normalizePositiveInteger(value: unknown): number {
  return Math.max(1, Math.floor(typeof value === 'number' && Number.isFinite(value) ? value : 1));
}

function normalizeOptionalText(text: string | null | undefined): string | undefined {
  const normalized = normalizeText(text ?? '');
  return normalized || undefined;
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .trim();
}

function normalizePhrase(text: string | null | undefined): string {
  return normalizeText(text ?? '')
    .replace(/^[\s"'“”‘’`.,，。!?！？:：;；()[\]{}<>《》【】]+/g, '')
    .replace(/[\s"'“”‘’`.,，。!?！？:：;；()[\]{}<>《》【】]+$/g, '')
    .trim();
}

function containsNormalized(haystack: string, needle: string): boolean {
  return normalizeLearningKey(haystack).includes(normalizeLearningKey(needle));
}

function sameNormalized(lhs: string, rhs: string): boolean {
  return normalizeLearningKey(lhs) === normalizeLearningKey(rhs);
}

function normalizeLearningKey(text: string): string {
  return normalizePhrase(text)
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}
