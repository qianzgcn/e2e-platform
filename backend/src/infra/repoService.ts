import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const REPOS_ROOT = path.resolve(process.cwd(), ".repos");

// 确保 projectId 对应的仓库已 clone 到 .repos/{projectId}/ 并 pull 到最新；返回本地路径。
export async function ensureRepo(repoUrl: string, projectId: number): Promise<string> {
  const repoDir = path.join(REPOS_ROOT, String(projectId));
  await mkdir(REPOS_ROOT, { recursive: true });

  if (await dirExists(repoDir)) {
    await runGit(["-C", repoDir, "pull", "--ff-only"]);
  } else {
    await runGit(["clone", "--depth", "1", repoUrl, repoDir]);
  }

  return repoDir;
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

function runGit(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(new Error(`git 执行失败: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git ${args.join(" ")} 失败 (code=${code ?? "null"}): ${stderr.trim()}`));
      }
    });
  });
}
