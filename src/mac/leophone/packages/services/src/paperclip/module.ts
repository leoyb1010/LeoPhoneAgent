export const paperclipModule = {
  id: "paperclip",
  requires: ["shared"],
  provides: ["paperclip-workspace"],
  publicEntrypoints: ["contract.ts", "adapters/createWorkspace.ts"],
} as const;
