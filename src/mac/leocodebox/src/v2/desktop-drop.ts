import { api } from './api';
import { droppedNativePath, pasteImageName, sanitizeDropName } from './session-drop';

type DesktopDropTools = {
  saveDrop?: (input: { cwd: string; name?: string; content?: string; fromPath?: string }) => Promise<{ path: string; name: string }>;
  clipboardImage?: () => Promise<{ empty?: boolean; name?: string; content?: string }>;
  pickFiles?: () => Promise<{ cancelled?: boolean; paths?: string[] }>;
};

function desktopTools(): DesktopDropTools | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.leocodeboxDesktopTools;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function saveIntoSession(cwd: string, input: { name?: string; content?: string; fromPath?: string }): Promise<string> {
  const desktop = desktopTools()?.saveDrop;
  if (desktop) {
    const row = await desktop({ cwd, ...input });
    return row.path;
  }
  return (await api.dropLocalFile(cwd, input)).path;
}

export async function dropBrowserFile(cwd: string, file: File & { path?: string }): Promise<string> {
  const native = droppedNativePath(file);
  if (native) return saveIntoSession(cwd, { fromPath: native, name: sanitizeDropName(file.name) });
  const bytes = new Uint8Array(await file.arrayBuffer());
  return saveIntoSession(cwd, { name: sanitizeDropName(file.name), content: bytesToBase64(bytes) });
}

export async function pasteSessionImage(cwd: string): Promise<string | null> {
  const read = desktopTools()?.clipboardImage;
  if (read) {
    const row = await read();
    if (row?.empty || !row?.content) return null;
    return saveIntoSession(cwd, { name: row.name || pasteImageName(), content: row.content });
  }
  return null;
}

export async function pickSessionFiles(cwd: string): Promise<string[]> {
  const pick = desktopTools()?.pickFiles;
  if (pick) {
    const row = await pick();
    if (row?.cancelled || !row?.paths?.length) return [];
    const out: string[] = [];
    for (const fromPath of row.paths) {
      out.push(await saveIntoSession(cwd, { fromPath }));
    }
    return out;
  }
  return [];
}
