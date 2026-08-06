/**
 * usage 映射 —— OpenAI Responses usage → Anthropic Messages usage。
 *
 * Responses: { input_tokens(含 cached), input_tokens_details:{cached_tokens},
 *              output_tokens(含 reasoning), output_tokens_details:{reasoning_tokens},
 *              total_tokens }
 * Anthropic:  { input_tokens(不含 cache_read), output_tokens,
 *               cache_read_input_tokens, cache_creation_input_tokens }
 *
 * 关键换算:Anthropic 的 input_tokens **不含** cache_read,而 Responses 的 input_tokens
 * **含** cached;所以 anthropic.input_tokens = responses.input_tokens - cached_tokens,
 * cache_read_input_tokens = cached_tokens。output_tokens 直接透传(已含 reasoning,正是要计费的)。
 */

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function mapUsage(responsesUsage: unknown): AnthropicUsage {
  const u = (responsesUsage ?? {}) as Record<string, unknown>;
  const inputTotal = num(u.input_tokens);
  const inputDetails = (u.input_tokens_details ?? {}) as Record<string, unknown>;
  const cached = num(inputDetails.cached_tokens);
  const output = num(u.output_tokens);
  return {
    input_tokens: Math.max(0, inputTotal - cached),
    output_tokens: output,
    cache_read_input_tokens: cached,
    // Responses 不区分 cache creation(它没有显式写缓存的概念);恒 0。
    cache_creation_input_tokens: 0,
  };
}
