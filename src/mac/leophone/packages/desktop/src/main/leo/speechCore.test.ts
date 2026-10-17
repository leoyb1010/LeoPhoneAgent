import assert from "node:assert/strict";
import { test } from "node:test";

import { markdownToSpeech, parseSpeechLine, parseSpeechSettings } from "./speechCore.js";

test("helper lines become typed events; garbage is dropped", () => {
  assert.deepEqual(parseSpeechLine('{"type":"ready","locale":"zh_CN"}'), {
    type: "ready",
    locale: "zh_CN",
  });
  assert.deepEqual(parseSpeechLine('{"text":"今天下午 3点","type":"partial"}'), {
    type: "partial",
    text: "今天下午 3点",
  });
  assert.deepEqual(parseSpeechLine('{"text":"好","type":"final"}'), { type: "final", text: "好" });
  assert.deepEqual(
    parseSpeechLine('{"type":"error","code":"mic_denied","message":"没有麦克风权限"}'),
    {
      type: "error",
      code: "mic_denied",
      message: "没有麦克风权限",
    },
  );
  assert.deepEqual(parseSpeechLine('{"type":"done"}'), { type: "done" });
  for (const line of ["", "hello", '{"type":"partial"}', '{"type":"weird"}', "[]", "null"]) {
    assert.equal(parseSpeechLine(line), null, line);
  }
});

test("settings default on with ⌥` and reject bad accelerators / locales", () => {
  assert.deepEqual(parseSpeechSettings(undefined), {
    dictationEnabled: true,
    readAloudEnabled: true,
    accelerator: "Alt+`",
    locale: null,
  });
  const parsed = parseSpeechSettings({
    dictationEnabled: false,
    accelerator: "Shift+A",
    locale: "zh-CN; rm -rf",
  });
  assert.equal(parsed.dictationEnabled, false);
  assert.equal(parsed.accelerator, "Alt+`");
  assert.equal(parsed.locale, null);
  assert.equal(
    parseSpeechSettings({ locale: "en-US", accelerator: "ctrl+alt+v" }).accelerator,
    "Control+Alt+V",
  );
  assert.equal(parseSpeechSettings({ locale: "en-US" }).locale, "en-US");
});

test("markdown is read as plain text without code blocks or link targets", () => {
  const spoken = markdownToSpeech(
    "## 结果\n\n- 改了 **两处**，见 [README](https://x.test/readme)\n\n```ts\nconst a = 1;\n```\n\n用 `pnpm test` 验证。",
  );
  assert.equal(spoken, "结果\n改了 两处，见 README\n代码略。\n用 pnpm test 验证。");
  assert.equal(markdownToSpeech("字".repeat(10), 4), "字字字字……");
});
