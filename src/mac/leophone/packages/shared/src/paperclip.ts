import { z } from "zod";

export const paperclipStoredReceiptSchema = z.object({
  id: z.string().min(1).max(256),
  identity: z.string().max(4096),
  kind: z.enum(["create", "comment", "status", "approval", "cancel"]),
  submittedAt: z.number().finite(),
  targetId: z.string().max(256).optional(),
  status: z.string().max(64).optional(),
  unblockAction: z.string().max(2000).optional(),
  operationTargetId: z.string().max(256).optional(),
  expectedStatus: z.string().max(64).optional(),
  state: z.enum(["unknown", "archived"]),
});
export type PaperclipStoredReceipt = z.infer<typeof paperclipStoredReceiptSchema>;

export const paperclipPreferencesSchema = z.object({
  origin: z.string().max(2048).default(""),
  companies: z.record(z.string().max(4096), z.string().max(256)).default({}),
  receipts: z.array(paperclipStoredReceiptSchema).max(100).optional(),
});
export type PaperclipPreferences = z.infer<typeof paperclipPreferencesSchema>;
export interface NativePaperclipPort {
  request(input: {
    serverUrl: string;
    method: "GET" | "POST" | "PATCH";
    path: string;
    body?: unknown;
    expectedUserId?: string;
  }): Promise<{ status: number; data: unknown }>;
  signIn(input: { serverUrl: string }): Promise<{ completed: boolean }>;
  signOut(input: { serverUrl: string }): Promise<void>;
  download(input: {
    serverUrl: string;
    path: string;
    filename: string;
    expectedUserId: string;
  }): Promise<void>;
  getPreferences(): Promise<PaperclipPreferences>;
  setPreferences(input: PaperclipPreferences): Promise<void>;
}
