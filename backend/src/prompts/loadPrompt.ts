import { readFile } from "node:fs/promises";
import path from "node:path";

export type PromptFileName = "case-generation.system.md" | "script-generation.system.md";

// 提示词文件很小，每次生成时重新读取，开发环境修改后无需重启服务。
export async function loadPrompt(fileName: PromptFileName): Promise<string> {
  const promptPath = path.resolve(process.cwd(), "prompts", fileName);

  try {
    return (await readFile(promptPath, "utf8")).trim();
  } catch (error) {
    throw new Error(`无法读取提示词文件：${fileName}`, { cause: error });
  }
}
