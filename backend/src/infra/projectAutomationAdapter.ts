import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectAutomationAdapter } from "../types/projectAutomation.js";

const ADAPTER_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ADAPTER_ROOT_SEGMENTS = ["tests", "project-helpers"] as const;

export class ProjectAutomationAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectAutomationAdapterError";
  }
}

export function validateAutomationAdapterKey(key: string) {
  if (!ADAPTER_KEY_PATTERN.test(key)) {
    throw new ProjectAutomationAdapterError(
      "自动化 Adapter key 无效，仅允许小写字母、数字和单个连字符分隔符",
    );
  }
}

export async function resolveProjectAutomationAdapter(key: string): Promise<ProjectAutomationAdapter> {
  validateAutomationAdapterKey(key);

  const modulePath = [...ADAPTER_ROOT_SEGMENTS, key, "index.ts"].join("/");
  const entryPath = path.resolve(process.cwd(), ...ADAPTER_ROOT_SEGMENTS, key, "index.ts");

  try {
    const entry = await stat(entryPath);
    if (!entry.isFile()) throw new Error("入口不是文件");
  } catch {
    throw new ProjectAutomationAdapterError(
      `自动化 Adapter “${key}” 未安装：缺少入口 ${modulePath}`,
    );
  }

  return {
    key,
    modulePath,
    importPath: `../project-helpers/${key}`,
  };
}

export async function listProjectAutomationAdapters(): Promise<string[]> {
  const root = path.resolve(process.cwd(), ...ADAPTER_ROOT_SEGMENTS);
  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const installed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ADAPTER_KEY_PATTERN.test(entry.name)) continue;

    try {
      const adapterEntry = await stat(path.join(root, entry.name, "index.ts"));
      if (adapterEntry.isFile()) installed.push(entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  return installed.sort();
}
