import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const {
  accessMock,
  execFileMock,
  openPathMock,
  showItemInFolderMock,
  loggerWarnMock,
} =
  vi.hoisted(() => ({
    accessMock: vi.fn(),
    execFileMock: vi.fn(),
    openPathMock: vi.fn(),
    showItemInFolderMock: vi.fn(),
    loggerWarnMock: vi.fn(),
  }));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("node:fs/promises", () => ({
  access: accessMock,
}));

vi.mock("electron", () => ({
  shell: {
    openPath: openPathMock,
    showItemInFolder: showItemInFolderMock,
  },
}));

vi.mock("../src/main/editors.js", () => ({
  getEditorDefsForCurrentPlatform: () => [
    {
      id: "explorer",
      name: "资源管理器",
      appPath: "C:/Windows/explorer.exe",
      command: null,
    },
    {
      id: "vscode",
      name: "VS Code",
      appPath: "C:/Users/demo/AppData/Local/Programs/Microsoft VS Code/Code.exe",
      command: "code",
    },
    {
      id: "qspace",
      name: "QSpace",
      appPath: "/Applications/QSpace.app",
      command: null,
    },
    {
      id: "qspace-pro",
      name: "QSpace Pro",
      appPath: "/Applications/QSpace Pro.app",
      command: null,
    },
  ],
  resolveEditorDefAppPath: (def: { appPath: string }) => def.appPath,
}));

vi.mock("../src/main/logger.js", () => ({
  logger: {
    warn: loggerWarnMock,
  },
}));

import { openInEditor } from "../src/main/openInEditor.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setProcessPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}

describe("openInEditor", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-open-in-editor-"));
    accessMock.mockReset();
    accessMock.mockResolvedValue(undefined);
    execFileMock.mockReset();
    openPathMock.mockReset();
    showItemInFolderMock.mockReset();
    loggerWarnMock.mockReset();
    openPathMock.mockResolvedValue("");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("Windows 目录路径应直接走 shell.openPath，避免 explorer fallback 双开", async () => {
    const result = await openInEditor("explorer", tempDir);

    expect(result).toEqual({ success: true });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(openPathMock).toHaveBeenCalledTimes(1);
    expect(openPathMock).toHaveBeenCalledWith(tempDir);
  });

  it("Windows 本地文件只调用一次 shell 定位，不启动 Explorer 子进程", async () => {
    setProcessPlatform("win32");
    const filePath = join(tempDir, "生成 文件.html");
    writeFileSync(filePath, "<html></html>");
    // 回归：旧实现即使 Explorer 已打开窗口，非零退出码仍会触发第二次定位。
    execFileMock.mockImplementation(
      (_file: string, _args: string[], callback: (error: Error | null) => void) => {
        callback(Object.assign(new Error("Command failed: explorer.exe"), { code: 1 }));
      },
    );

    const result = await openInEditor("explorer", filePath);

    expect(result).toEqual({ success: true });
    expect(execFileMock).not.toHaveBeenCalled();
    expect(showItemInFolderMock).toHaveBeenCalledExactlyOnceWith(filePath);
    expect(openPathMock).not.toHaveBeenCalled();
  });

  it("Windows CLI 命令不可用时应回退到编辑器 exe 打开目录", async () => {
    setProcessPlatform("win32");
    execFileMock.mockImplementation(
      (file: string, _args: string[], callback: (error: Error | null) => void) => {
        callback(file === "code" ? new Error("missing code cli") : null);
      },
    );

    const result = await openInEditor("vscode", tempDir);

    expect(result).toEqual({ success: true });
    expect(execFileMock).toHaveBeenNthCalledWith(1, "code", [tempDir], expect.any(Function));
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "C:/Users/demo/AppData/Local/Programs/Microsoft VS Code/Code.exe",
      [tempDir],
      expect.any(Function),
    );
  });

  it("SSH 远程工作区用 VS Code 打开时应走 Remote-SSH folder URI", async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], callback: (error: Error | null) => void) => {
        callback(null);
      },
    );

    const result = await openInEditor("vscode", "/root/demo-project", {
      remoteTarget: {
        kind: "ssh",
        host: "jumpserver.example.com",
        port: 2222,
        username: "asset01@root@192.168.100.166",
        sshConfigAlias: "zcode",
      },
    });

    expect(result).toEqual({ success: true });
    expect(execFileMock).toHaveBeenCalledWith(
      "code",
      ["--folder-uri", "vscode-remote://ssh-remote+zcode/root/demo-project"],
      expect.any(Function),
    );
  });

  it("SSH 远程文件用 VS Code 打开时应走 Remote-SSH file URI", async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], callback: (error: Error | null) => void) => {
        callback(null);
      },
    );

    const result = await openInEditor("vscode", "/root/demo-project/src/index.ts", {
      pathKind: "file",
      remoteTarget: {
        kind: "ssh",
        host: "jumpserver.example.com",
        port: 2222,
        username: "root",
        sshConfigAlias: "zcode",
      },
    });

    expect(result).toEqual({ success: true });
    expect(execFileMock).toHaveBeenCalledWith(
      "code",
      ["--file-uri", "vscode-remote://ssh-remote+zcode/root/demo-project/src/index.ts"],
      expect.any(Function),
    );
  });

  it("SSH 远程工作区没有 alias 时应编码 VS Code Remote-SSH authority", async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], callback: (error: Error | null) => void) => {
        callback(null);
      },
    );

    const result = await openInEditor("vscode", "/root/demo-project", {
      remoteTarget: {
        kind: "ssh",
        host: "192.168.100.166",
        port: 2222,
        username: "asset01@root",
      },
    });

    expect(result).toEqual({ success: true });
    expect(execFileMock).toHaveBeenCalledWith(
      "code",
      [
        "--folder-uri",
        "vscode-remote://ssh-remote+asset01%40root%40192.168.100.166%3A2222/root/demo-project",
      ],
      expect.any(Function),
    );
  });

  it("macOS QSpace 应通过 app bundle 打开目录", async () => {
    setProcessPlatform("darwin");
    execFileMock.mockImplementation(
      (_file: string, _args: string[], callback: (error: Error | null) => void) => {
        callback(null);
      },
    );

    const result = await openInEditor("qspace", tempDir);

    expect(result).toEqual({ success: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "open",
      ["-a", "/Applications/QSpace.app", tempDir],
      expect.any(Function),
    );
  });

  it("macOS QSpace Pro 应通过 app bundle 打开目录", async () => {
    setProcessPlatform("darwin");
    execFileMock.mockImplementation(
      (_file: string, _args: string[], callback: (error: Error | null) => void) => {
        callback(null);
      },
    );

    const result = await openInEditor("qspace-pro", tempDir);

    expect(result).toEqual({ success: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "open",
      ["-a", "/Applications/QSpace Pro.app", tempDir],
      expect.any(Function),
    );
  });
});
