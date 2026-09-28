import assert from "node:assert/strict";
import test from "node:test";
import { leoDeviceDescriptorSchema } from "./leoDevice.js";

const descriptor = {
  schemaVersion: 1,
  deviceId: "9c0f2c99-17cf-47a1-a370-d97161f68f9a",
  name: "My Mac",
  platform: "macos",
  capabilities: ["harness", "future-capability"],
  endpoints: [{ id: "direct", kind: "direct", baseURL: "https://my-mac.example.ts.net/leo" }],
};

test("paired device metadata accepts additive capabilities without echoing credentials", () => {
  const parsed = leoDeviceDescriptorSchema.parse({
    ...descriptor,
    accessKey: "must-not-be-forwarded",
  });
  assert.deepEqual(parsed.capabilities, descriptor.capabilities);
  assert.equal("accessKey" in parsed, false);
  assert.equal(parsed.deviceId, descriptor.deviceId);
});

test("connection metadata never transports credentials in URLs", () => {
  for (const baseURL of [
    "http://host/",
    "https://user:secret@host/",
    "https://host/?token=secret",
    "https://host/#secret",
    "file:///tmp/host",
  ]) {
    const result = leoDeviceDescriptorSchema.safeParse({
      ...descriptor,
      endpoints: [{ id: "bad", kind: "direct", baseURL }],
    });
    assert.equal(result.success, false, baseURL);
  }
});

test("duplicate endpoint IDs cannot ambiguously replace an authorized route", () => {
  assert.equal(
    leoDeviceDescriptorSchema.safeParse({
      ...descriptor,
      endpoints: [descriptor.endpoints[0], descriptor.endpoints[0]],
    }).success,
    false,
  );
});

test("unknown schema version and invalid identity require compatibility fallback", () => {
  assert.equal(
    leoDeviceDescriptorSchema.safeParse({ ...descriptor, schemaVersion: 2 }).success,
    false,
  );
  assert.equal(
    leoDeviceDescriptorSchema.safeParse({ ...descriptor, deviceId: "same-display-name" }).success,
    false,
  );
});
