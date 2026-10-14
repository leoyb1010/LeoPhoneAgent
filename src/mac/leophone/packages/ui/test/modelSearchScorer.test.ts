import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_SEARCH_EXACT_SCORE,
  MODEL_SEARCH_FUZZY_SCORE,
  MODEL_SEARCH_PREFIX_SCORE,
  MODEL_SEARCH_PROVIDER_PENALTY,
  MODEL_SEARCH_SUBSTRING_SCORE,
  MODEL_SEARCH_WORD_BOUNDARY_SCORE,
  normalizeModelSearchText,
  rankModelSearch,
  scoreModelSearch,
  termScore,
  type ModelSearchFields,
} from "../src/lib/modelSearchScorer.js";

function fields(
  modelId: string,
  displayName = modelId,
  providerLabel = "",
  baseDisplayName = displayName,
): ModelSearchFields {
  return { modelId, displayName, baseDisplayName, providerLabel };
}

test("empty or whitespace query matches everything with score 0", () => {
  assert.equal(scoreModelSearch("", fields("gpt-5.5")), 0);
  assert.equal(scoreModelSearch("   ", fields("gpt-5.5")), 0);
});

test("term tiers: prefix > word boundary > substring > fuzzy", () => {
  assert.equal(termScore("claude", "claude-opus-5", true), MODEL_SEARCH_PREFIX_SCORE);
  assert.equal(termScore("opus", "claude-opus-5", true), MODEL_SEARCH_WORD_BOUNDARY_SCORE);
  assert.equal(termScore("pus", "claude-opus-5", true), MODEL_SEARCH_SUBSTRING_SCORE);
  // c..l..o 按序出现：跨度 3（"cla" 中 c→l 相邻，再到 o 在 "claude-o" 位置）
  const fuzzy = termScore("cdo", "claude-opus", true);
  assert.ok(fuzzy !== null && fuzzy > 0 && fuzzy < MODEL_SEARCH_SUBSTRING_SCORE);
  assert.ok(fuzzy <= MODEL_SEARCH_FUZZY_SCORE);
  // 模糊匹配要求至少 3 个字符，且服务商字段不允许模糊。
  assert.equal(termScore("cd", "claude", true), null);
  assert.equal(termScore("cdo", "claude-opus", false), null);
});

test("fuzzy score shrinks with gaps but never below 1", () => {
  const tight = termScore("abc", "a-b-c", true);
  const loose = termScore("abc", `a${"x".repeat(300)}b c`, true);
  assert.ok(tight !== null && loose !== null);
  assert.ok(tight > loose);
  assert.equal(loose, 1);
});

test("every term must match some field", () => {
  assert.equal(scoreModelSearch("opus banana", fields("claude-opus-5")), null);
  assert.equal(
    scoreModelSearch("claude opus", fields("claude-opus-5")),
    MODEL_SEARCH_PREFIX_SCORE + MODEL_SEARCH_WORD_BOUNDARY_SCORE,
  );
});

test("provider name match is penalised below model field match", () => {
  const viaProvider = scoreModelSearch("openai", fields("gpt-5.5", "GPT 5.5", "OpenAI"));
  assert.equal(viaProvider, MODEL_SEARCH_PREFIX_SCORE - MODEL_SEARCH_PROVIDER_PENALTY);
  const viaModel = scoreModelSearch("openai", fields("openai-o5", "o5", "Other"));
  assert.equal(viaModel, MODEL_SEARCH_PREFIX_SCORE);
  // 同时命中取较高者。
  assert.equal(
    scoreModelSearch("gpt", fields("gpt-5.5", "GPT 5.5", "gpt proxy")),
    MODEL_SEARCH_PREFIX_SCORE,
  );
});

test("exact id or display name match gets the exact boost", () => {
  assert.equal(
    scoreModelSearch("GPT-5.5", fields("gpt-5.5", "GPT 5.5")),
    MODEL_SEARCH_PREFIX_SCORE + MODEL_SEARCH_EXACT_SCORE,
  );
  assert.equal(
    scoreModelSearch("gpt 5.5", fields("gpt-5.5", "GPT 5.5")),
    MODEL_SEARCH_PREFIX_SCORE + MODEL_SEARCH_WORD_BOUNDARY_SCORE + MODEL_SEARCH_EXACT_SCORE,
  );
  const ranked = rankModelSearch(
    [fields("gpt-5.5-mini"), fields("gpt-5.5")],
    "gpt-5.5",
    (item) => item,
  );
  assert.deepEqual(
    ranked.map((item) => item.modelId),
    ["gpt-5.5", "gpt-5.5-mini"],
  );
});

test("case, diacritic and full/half width insensitive", () => {
  assert.equal(normalizeModelSearchText("ＧＰＴ－５"), "gpt-5");
  assert.equal(normalizeModelSearchText("Café Ünïcode"), "cafe unicode");
  assert.equal(
    scoreModelSearch("ＧＰＴ", fields("gpt-5.5")),
    scoreModelSearch("gpt", fields("gpt-5.5")),
  );
  assert.equal(scoreModelSearch("CAFE", fields("café-model")), MODEL_SEARCH_PREFIX_SCORE);
  // 全角空格也能拆词。
  assert.equal(
    scoreModelSearch("claude\u3000opus", fields("claude-opus-5")),
    MODEL_SEARCH_PREFIX_SCORE + MODEL_SEARCH_WORD_BOUNDARY_SCORE,
  );
});

test("Chinese queries match display names and provider labels", () => {
  assert.equal(
    scoreModelSearch("通义", fields("qwen3-max", "通义千问 3 Max", "阿里云百炼")),
    MODEL_SEARCH_PREFIX_SCORE,
  );
  // 汉字属于字母类：中间命中算子串而不是词边界。
  assert.equal(
    scoreModelSearch("千问", fields("qwen3-max", "通义千问 3 Max")),
    MODEL_SEARCH_SUBSTRING_SCORE,
  );
  assert.equal(
    scoreModelSearch("百炼", fields("qwen3-max", "Qwen3 Max", "阿里云百炼")),
    MODEL_SEARCH_SUBSTRING_SCORE - MODEL_SEARCH_PROVIDER_PENALTY,
  );
  assert.equal(scoreModelSearch("智谱", fields("glm-5", "GLM 5", "Z.ai")), null);
});

test("ranking is stable for ties and drops non-matches", () => {
  const items = [
    fields("a-opus", "A Opus"),
    fields("haiku", "Haiku"),
    fields("b-opus", "B Opus"),
    fields("opus-max", "Opus Max"),
    fields("c-opus", "C Opus"),
  ];
  assert.deepEqual(
    rankModelSearch(items, "opus", (item) => item).map((item) => item.modelId),
    ["opus-max", "a-opus", "b-opus", "c-opus"],
  );
  assert.deepEqual(
    rankModelSearch(items, "", (item) => item).map((item) => item.modelId),
    items.map((item) => item.modelId),
  );
});
