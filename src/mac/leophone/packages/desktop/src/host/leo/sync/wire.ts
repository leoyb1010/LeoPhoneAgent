export type FieldValue =
  | { t: "null" }
  | { t: "string" | "json" | "data"; v: string }
  | { t: "int" | "double" | "date"; v: number }
  | { t: "bool"; v: boolean };
export interface AssetReference {
  key: string;
  sha256: string;
  size: number;
  mimeType?: string;
}
export interface WireRecord {
  id: { type: string; id: string };
  fields: Record<string, FieldValue>;
  assets: Record<string, AssetReference>;
  schemaVersion: number;
  minimumCompatibleVersion?: number;
  unknownFields: Record<string, FieldValue>;
  updatedAt: number;
}
export interface SyncChange {
  changeId: string;
  revision: number;
  id: { type: string; id: string };
  operation: "upsert" | "delete";
  updatedAt: number;
  record?: WireRecord;
}
export interface Receipt {
  changeId: string;
  revision: number;
  status: "stored" | "superseded";
  cursor: number;
}
export class ReplicaError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const MAX_ASSET = 256 * 1024 * 1024;
export const MAX_CHUNK = 1024 * 1024;
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const types = new Set([
  "SessionV2",
  "MessageV2",
  "CompactMarkerV2",
  "SessionFileV2",
  "ArtifactV2",
  "ArtifactVersionV2",
  "SkillV2",
  "ProviderConfigV2",
  "MCPServersV2",
  "MCPServerItem",
  "ProviderInstanceV3",
  "ProviderModelEntryV3",
  "ProviderModelGroupV3",
  "EnvVarV2",
  "EnvVarItem",
  "SyncDeviceV2",
  "SoulV2",
  "MemoryGlobalV2",
  "MemoryDailyV2",
]);
export function check(value: unknown, message: string, status = 400): asserts value {
  if (!value) throw new ReplicaError(status, message);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function fields(value: unknown) {
  check(object(value), "invalid portable fields");
  check(Object.keys(value).length <= 512, "too many portable fields");
  for (const [key, field] of Object.entries(value)) {
    check(text(key, 128) && object(field), "invalid portable field");
    const tag = field.t;
    check(
      ["null", "string", "json", "data", "int", "double", "date", "bool"].includes(String(tag)),
      "unknown portable field tag",
    );
    if (tag === "null") continue;
    if (["string", "json", "data"].includes(String(tag)))
      check(typeof field.v === "string", "invalid string field");
    else if (tag === "bool") check(typeof field.v === "boolean", "invalid bool field");
    else
      check(
        typeof field.v === "number" &&
          Number.isFinite(field.v) &&
          (tag !== "int" || Number.isSafeInteger(field.v)),
        "invalid numeric field",
      );
  }
}
export function validateChanges(value: unknown): SyncChange[] {
  check(
    Array.isArray(value) && value.length > 0 && value.length <= 100,
    "batch must contain 1..100 changes",
  );
  for (const c of value) {
    check(
      object(c) &&
        text(c.changeId) &&
        integer(c.revision) &&
        object(c.id) &&
        types.has(String(c.id.type)) &&
        text(c.id.id, 2048),
      "invalid change identity",
    );
    check(c.operation === "upsert" || c.operation === "delete", "invalid operation");
    check(typeof c.updatedAt === "number" && Number.isFinite(c.updatedAt), "invalid updatedAt");
    if (c.operation === "delete") {
      check(c.record === undefined, "delete must not contain record");
      continue;
    }
    const r = c.record;
    check(
      object(r) &&
        object(r.id) &&
        r.id.type === c.id.type &&
        r.id.id === c.id.id &&
        r.updatedAt === c.updatedAt &&
        integer(r.schemaVersion),
      "record identity/version mismatch",
    );
    if (r.minimumCompatibleVersion !== undefined)
      check(integer(r.minimumCompatibleVersion), "invalid compatible version");
    fields(r.fields);
    fields(r.unknownFields);
    check(object(r.assets) && Object.keys(r.assets).length <= 32, "invalid assets");
    for (const [key, asset] of Object.entries(r.assets)) {
      check(
        text(key, 128) &&
          object(asset) &&
          asset.key === key &&
          typeof asset.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(asset.sha256),
        "invalid asset identity",
      );
      check(
        typeof asset.size === "number" &&
          Number.isSafeInteger(asset.size) &&
          asset.size >= 0 &&
          asset.size <= MAX_ASSET,
        "invalid asset size",
      );
      check(
        asset.fileURL === undefined &&
          Object.keys(asset).every((k) => ["key", "sha256", "size", "mimeType"].includes(k)),
        "local asset paths forbidden",
      );
      check(asset.mimeType === undefined || text(asset.mimeType, 256), "invalid asset mime");
    }
  }
  return value as SyncChange[];
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
