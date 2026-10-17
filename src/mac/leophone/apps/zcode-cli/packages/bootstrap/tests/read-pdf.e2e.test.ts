import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createJimpImageProcessorAdapter } from "@zcode/adapters/image";
import { createPopplerPdfDocumentAdapter } from "@zcode/adapters/pdf";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import {
  createModelId,
  createModelProviderId,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
} from "@zcode/contracts";
import { AgentRuntime } from "@zcode/core";

const popplerAvailable =
  (await commandSucceeds("pdfinfo", ["-v"])) && (await commandSucceeds("pdftoppm", ["-v"]));

// 上游测试漂移（类别 2）：原「Read PDF provider and cold-resume E2E」用例基于已从上游移除的
// AiSdkModelRegistry 与 AgentRuntime modelRef/modelAdapter 注入 API，整段删除；
// Read PDF 的 Poppler 执行链路仍由下方用例覆盖。
describe.skipIf(!popplerAvailable)("Read PDF Poppler E2E", () => {
  it("runs the runtime descriptor and executor through Poppler in page order", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-read-pdf-e2e-"));
    const pdfPath = join(root, "two-pages.pdf");
    const executionPort = createNodeExecutionAdapter({
      outputRootDir: join(root, "exec-output"),
      processEnv: process.env,
    });

    try {
      await writeFile(pdfPath, buildTwoPagePdf());
      const sessionId = createSessionId("read-pdf-e2e");
      const turnId = createTurnId("read-pdf-e2e");
      const traceContext = createRootTraceContext({ sessionId, turnId });
      const runtime = new AgentRuntime(
        sessionId,
        {
          mode: "yolo",
          modelInputMediaCapabilities: { supportsImages: true, supportsPdf: true },
          workingDirectory: root,
        },
        {
          eventStore: createInMemorySessionEventStore(),
          executionPort,
          fileSystemPort: createNodeFileSystemAdapter(),
          imageProcessorPort: createJimpImageProcessorAdapter(),
          pdfDocumentPort: createPopplerPdfDocumentAdapter({ executionPort }),
        },
      );
      const model = {
        providerId: createModelProviderId("test"),
        modelId: createModelId("pdf-e2e"),
        // 上游测试漂移：Model 能力已改为 properties.inputFormat（Registry ModelPropertiesConfig 形状）。
        properties: {
          inputFormat: {
            supportsText: true,
            supportsImage: true,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: true,
          },
        },
      } as never;

      const readTool = runtime.getTools(model).find((tool) => tool.name === "Read")!;
      expect(readTool.inputSchema.properties.pages).toMatchObject({ type: "string" });

      const result = await runtime.getToolExecutor().execute(
        {
          id: createToolCallId("read-pdf-pages"),
          name: "Read",
          input: { file_path: pdfPath, pages: "1-2" },
        },
        { model, traceContext },
      );
      expect(result.success).toBe(true);
      expect(result.modelContent).toEqual([
        {
          type: "text",
          text: expect.stringMatching(
            /^PDF pages extracted: 2 page\(s\) from .*two-pages\.pdf \([\d.]+(?:KB| bytes)\)$/u,
          ),
        },
        expect.objectContaining({ type: "image", mediaType: "image/jpeg" }),
        expect.objectContaining({ type: "image", mediaType: "image/jpeg" }),
      ]);

      const pageDataUrls = (result.modelContent as any[])
        .filter((block) => block.type === "image")
        .map((block) => block.dataUrl);
      expect(pageDataUrls).toHaveLength(2);
      expect(pageDataUrls[0]).not.toBe(pageDataUrls[1]);
    } finally {
      await executionPort.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function commandSucceeds(command: string, args: string[]): Promise<boolean> {
  return await new Promise((resolve) => {
    execFile(command, args, { timeout: 5_000 }, (error) => resolve(error === null));
  });
}

function buildTwoPagePdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 160 240] >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source, "ascii"));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source, "ascii");
  source += `xref\n0 ${objects.length + 1}\n`;
  source += "0000000000 65535 f \n";
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  source += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source, "ascii");
}
