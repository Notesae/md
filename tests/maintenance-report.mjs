import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** 保留每次独立夹具的报告，同时维护模式与最新入口，避免后续失败覆盖已有原生证据。 */
export async function saveMaintenanceReport(workspace, result) {
  const directory = path.join(workspace, ".reports");
  const archive = path.join(directory, "native-maintenance", `${path.basename(result.base)}.json`);
  await mkdir(path.dirname(archive), { recursive: true });
  const body = JSON.stringify(result, null, 2);
  await Promise.all([
    writeFile(archive, body),
    writeFile(path.join(directory, `native-maintenance-${result.mode}.json`), body),
    writeFile(path.join(directory, "native-maintenance.json"), body),
  ]);
}
