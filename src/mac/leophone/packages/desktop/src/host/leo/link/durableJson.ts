import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";

/** 落盘先于授权/执行回执；rename 防止崩溃留下半份 JSON。 */
export async function writeDurableJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(`${file}.tmp`, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(`${file}.tmp`, file);
  const directory = await open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
