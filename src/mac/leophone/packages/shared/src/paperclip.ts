import { z } from "zod";

export const paperclipPreferencesSchema = z.object({
  origin: z.string().max(2048).default(""),
  companies: z.record(z.string().max(4096), z.string().max(256)).default({}),
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
