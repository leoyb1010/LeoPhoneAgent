import type { NativePaperclipPort } from "@zcode/shared";
import type { IPaperclipWorkspace } from "../contract.js";
import { PaperclipWorkspace } from "../app/workspace.js";
export function createPaperclipWorkspace(port: NativePaperclipPort): IPaperclipWorkspace {
  return new PaperclipWorkspace(port);
}
