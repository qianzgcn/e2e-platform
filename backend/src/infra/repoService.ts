import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const REPOS_ROOT = path.resolve(process.cwd(), ".repos");

// 确保 projectId 对应的仓库已 clone 到 .repos/{projectId}/ 并 pull 到最新；返回本地路径。
export async function ensureRepo(repoUrl: string, projectId: number): Promise<string> {
  const repoDir = path.join(REPOS_ROOT, String(projectId));
  await mkdir(REPOS_ROOT, { recursive: true });

  if (await dirExists(repoDir)) {
    log(`pull 仓库 projectId=${projectId} → ${repoDir}`);
    await runGit(["-C", repoDir, "pull", "--ff-only"]);
    log(`仓库已更新 ${repoDir}`);
  } else {
    log(`clone 仓库 projectId=${projectId}`);
    await runGit(["clone", "--depth", "1", repoUrl, repoDir]);
    log(`仓库已就绪 ${repoDir}`);
  }

  return repoDir;
}

// 测试仓库 URL 是否可访问（git ls-remote，不 clone）。失败抛错。
export async function testRepoConnectivity(repoUrl: string): Promise<void> {
  log(`测试连通 ${repoUrl}`);
  await runGit(["ls-remote", repoUrl]);
  log(`连通正常 ${repoUrl}`);
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

function log(message: string) {
  console.log(`[repoService] ${message}`);
}

function runGit(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        // 跳过首次连接 gitee/github 的 host key 交互确认；BatchMode 让 SSH 认证失败时直接报错而非卡密码提示。
        // 安全权衡：跳过 host 校验有 MITM 风险，本平台是内部工具、仓库 URL 由管理员配置，可接受。
        GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes",
        // 禁止 git 的 HTTPS 认证交互提示（用户名/密码），认证信息不全直接失败。
        GIT_TERMINAL_PROMPT: "0",
      },
    });
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
