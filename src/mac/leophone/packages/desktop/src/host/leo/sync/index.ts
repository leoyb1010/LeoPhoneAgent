import { createReplicaHandler } from "./http.js";
import { SyncReplicaStore } from "./replica.js";
export type { ReplicaHandler, ReplicaPrincipal } from "./http.js";
export async function createSyncReplica(directory: string) {
  const store = await SyncReplicaStore.open(directory);
  return { handle: createReplicaHandler(store), close: () => store.close() };
}
export { createTreasuryHandler } from "./treasury.js";
