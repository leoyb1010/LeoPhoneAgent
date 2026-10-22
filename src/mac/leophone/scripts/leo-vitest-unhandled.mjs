// [up3-relay-scripts] leo-vitest-ratchet 用的小 reporter:把这次运行里测试之外的未处理错误数写进文件。
// vitest 4 的 JSON 报告 success 只看失败用例,不看未处理错误,只能在这里数。
import { writeFileSync } from "node:fs";

export default class LeoVitestUnhandledReporter {
  onTestRunEnd(_testModules, unhandledErrors) {
    const out = process.env.LEO_VITEST_UNHANDLED_OUT;
    if (out) writeFileSync(out, String(unhandledErrors?.length ?? 0));
  }
}
