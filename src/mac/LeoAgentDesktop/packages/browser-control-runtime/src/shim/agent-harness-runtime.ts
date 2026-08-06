/**
 * Shim: openclaw/plugin-sdk/agent-harness-runtime.
 *
 * Gateway/node-routing tool helpers used only by the dropped CLI/node-host
 * surface (via the `sdk-setup-tools` bridge re-export). Never called on the
 * in-process dispatcher path. Stubs throw if mistakenly reached; types are
 * minimal placeholders.
 */
export type AnyAgentTool = Record<string, unknown>;
export type NodeListNode = { id: string; [key: string]: unknown };

function dropped(name: string): never {
  throw new Error(`agent-harness-runtime.${name} is not available in the in-process runtime`);
}

export function callGatewayTool(): never {
  return dropped('callGatewayTool');
}
export function listNodes(): never {
  return dropped('listNodes');
}
export function resolveNodeIdFromList(): never {
  return dropped('resolveNodeIdFromList');
}
export function selectDefaultNodeFromList(): never {
  return dropped('selectDefaultNodeFromList');
}
