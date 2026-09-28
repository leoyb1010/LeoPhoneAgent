import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { leoDeviceDescriptorSchema } from "@zcode/shared/leo-device";

const identitySchema = leoDeviceDescriptorSchema.pick({ schemaVersion: true, deviceId: true });

async function readIdentity(file: string): Promise<string> {
  return identitySchema.parse(JSON.parse(await readFile(file, "utf8"))).deviceId;
}

/** 多个窗口同时首次启动也只能认领一个完整身份；损坏的已有身份必须显式恢复。 */
export async function loadDeviceIdentity(file: string): Promise<string> {
  try {
    return await readIdentity(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, deviceId: randomUUID() }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // link 是不覆盖已有文件的原子发布，竞争失败者读取胜者，不另造身份。
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return await readIdentity(file);
  } finally {
    await rm(temporary, { force: true });
  }
}
