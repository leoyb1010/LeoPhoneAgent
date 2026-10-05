export const paperclipModule = {
  id: "paperclip",
  requires: ["shared", "services"],
  provides: ["paperclip-workspace"],
  publicEntrypoints: ["contract.ts", "adapters/createWorkspace.ts"],
} as const;
