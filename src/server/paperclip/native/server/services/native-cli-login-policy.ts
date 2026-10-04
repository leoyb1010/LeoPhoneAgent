/** Dedicated opt-in for a self-hosted operator. It confers no MCP/stdio trust. */
export function nativeAdapterLoginSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === "darwin" && env.PAPERCLIP_NATIVE_CLI_LOGIN_ENABLED === "true";
}
