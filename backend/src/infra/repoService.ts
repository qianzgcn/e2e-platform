import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPOS_ROOT = path.resolve(process.cwd(), ".repos");
const repositorySyncs = new Map<number, Promise<unknown>>();

export type RepositorySource = {
  repoUrl: string;
  repoBranch: string | null;
  repoSubdirectory: string | null;
};

export type RepositorySourceInput = {
  repoUrl?: unknown;
  repoBranch?: unknown;
  repoSubdirectory?: unknown;
};

export class RepositorySourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositorySourceError";
  }
}

export function normalizeRepositorySource(input: RepositorySourceInput): RepositorySource | null {
  const repoUrl = normalizeOptionalString(input.repoUrl, "代码仓库 URL");
  const repoBranch = normalizeOptionalString(input.repoBranch, "仓库分支");
  const rawSubdirectory = normalizeOptionalString(input.repoSubdirectory, "仓库子目录");

  if (!repoUrl) {
    if (repoBranch || rawSubdirectory) {
      throw new RepositorySourceError("配置仓库分支或子目录前，请先填写代码仓库 URL");
    }
    return null;
  }

  if (repoUrl.length > 500) {
    throw new RepositorySourceError("代码仓库 URL 不能超过 500 个字符");
  }
  if (containsControlCharacter(repoUrl)) {
    throw new RepositorySourceError("代码仓库 URL 包含非法控制字符");
  }
  if (repoUrl.startsWith("-")) {
    throw new RepositorySourceError("代码仓库 URL 不能以 - 开头");
  }
  if (repoBranch) {
    validateBranch(repoBranch);
  }

  return {
    repoUrl,
    repoBranch,
    repoSubdirectory: rawSubdirectory ? normalizeSubdirectory(rawSubdirectory) : null,
  };
}

// 确保项目仓库缓存与当前配置一致，并返回 AI 实际允许分析的目录。
export function ensureRepo(source: RepositorySource, projectId: number): Promise<string> {
  const normalized = normalizeRepositorySource(source);
  if (!normalized) {
    throw new RepositorySourceError("项目未配置代码仓库");
  }

  return serializeProjectSync(projectId, () => syncRepository(normalized, projectId));
}

// 测试 remote、分支及可选子目录；子目录使用临时 sparse checkout 做真实验证。
export async function testRepoConnectivity(source: RepositorySource): Promise<void> {
  const normalized = normalizeRepositorySource(source);
  if (!normalized) {
    throw new RepositorySourceError("请输入代码仓库 URL");
  }

  log("测试代码仓库连通性");
  try {
    await runGit(["ls-remote", normalized.repoUrl]);
  } catch (error) {
    throw new RepositorySourceError(
      `仓库不可访问，请填写 Git clone 地址；网页中的分支和子目录请分别配置。${formatGitDetail(error)}`,
    );
  }

  if (normalized.repoBranch) {
    try {
      await runGit([
        "ls-remote",
        "--exit-code",
        "--heads",
        normalized.repoUrl,
        `refs/heads/${normalized.repoBranch}`,
      ]);
    } catch {
      throw new RepositorySourceError(`仓库中不存在或无法访问分支 ${normalized.repoBranch}`);
    }
  }

  if (normalized.repoSubdirectory) {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "e2e-platform-repo-"));
    const tempRepo = path.join(tempRoot, "repository");
    try {
      await cloneRepository(normalized, tempRepo);
      await assertSubdirectoryExists(tempRepo, normalized.repoSubdirectory);
    } catch (error) {
      if (error instanceof RepositorySourceError) {
        throw error;
      }
      throw new RepositorySourceError(`仓库子目录验证失败。${formatGitDetail(error)}`);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  log("代码仓库配置验证通过");
}

async function syncRepository(source: RepositorySource, projectId: number) {
  const repoDir = path.join(REPOS_ROOT, String(projectId));
  const sourceMarker = path.join(REPOS_ROOT, `${projectId}.source`);
  const fingerprint = createSourceFingerprint(source);
  await mkdir(REPOS_ROOT, { recursive: true });

  const cacheMatches = await isMatchingCache(repoDir, sourceMarker, fingerprint);
  if (!cacheMatches) {
    await Promise.all([
      rm(repoDir, { recursive: true, force: true }),
      rm(sourceMarker, { force: true }),
    ]);
    log(`clone 仓库 projectId=${projectId}`);
    try {
      await cloneRepository(source, repoDir);
      await assertConfiguredRootExists(repoDir, source.repoSubdirectory);
      await writeFile(sourceMarker, fingerprint, "utf8");
    } catch (error) {
      await Promise.all([
        rm(repoDir, { recursive: true, force: true }),
        rm(sourceMarker, { force: true }),
      ]);
      if (error instanceof RepositorySourceError) throw error;
      throw new RepositorySourceError(`代码仓库同步失败。${formatGitDetail(error)}`);
    }
  } else {
    log(`更新仓库 projectId=${projectId}`);
    try {
      await runGit(["-C", repoDir, "reset", "--hard", "HEAD"]);
      await runGit(["-C", repoDir, "clean", "-fd"]);
      await runGit(["-C", repoDir, "pull", "--ff-only"]);
      if (source.repoSubdirectory) {
        await configureSparseCheckout(repoDir, source.repoSubdirectory);
      }
      await assertConfiguredRootExists(repoDir, source.repoSubdirectory);
    } catch (error) {
      if (error instanceof RepositorySourceError) throw error;
      throw new RepositorySourceError(`代码仓库更新失败。${formatGitDetail(error)}`);
    }
  }

  const repositoryRoot = resolveConfiguredRoot(repoDir, source.repoSubdirectory);
  log(`仓库已就绪 projectId=${projectId} root=${path.relative(REPOS_ROOT, repositoryRoot)}`);
  return repositoryRoot;
}

async function cloneRepository(source: RepositorySource, destination: string) {
  const args = ["clone", "--depth", "1"];
  if (source.repoSubdirectory) {
    args.push("--filter=blob:none", "--sparse");
  }
  if (source.repoBranch) {
    args.push("--branch", source.repoBranch);
  }
  args.push(source.repoUrl, destination);
  await runGit(args);

  if (source.repoSubdirectory) {
    await configureSparseCheckout(destination, source.repoSubdirectory);
  }
}

async function configureSparseCheckout(repoDir: string, subdirectory: string) {
  try {
    await runGit(["-C", repoDir, "sparse-checkout", "set", "--cone", "--", subdirectory]);
  } catch {
    throw new RepositorySourceError(`仓库中不存在或无法检出目录 ${subdirectory}`);
  }
}

async function assertConfiguredRootExists(repoDir: string, subdirectory: string | null) {
  if (subdirectory) {
    await assertSubdirectoryExists(repoDir, subdirectory);
    return;
  }
  if (!(await dirExists(repoDir))) {
    throw new RepositorySourceError("代码仓库没有成功检出");
  }
}

async function assertSubdirectoryExists(repoDir: string, subdirectory: string) {
  const target = resolveConfiguredRoot(repoDir, subdirectory);
  try {
    if ((await stat(target)).isDirectory()) return;
  } catch {
    // 统一转换为用户可操作的目录错误。
  }
  throw new RepositorySourceError(`仓库中不存在目录 ${subdirectory}`);
}

function resolveConfiguredRoot(repoDir: string, subdirectory: string | null) {
  return subdirectory ? path.join(repoDir, ...subdirectory.split("/")) : repoDir;
}

async function isMatchingCache(repoDir: string, sourceMarker: string, fingerprint: string) {
  if (!(await dirExists(path.join(repoDir, ".git")))) return false;
  try {
    return (await readFile(sourceMarker, "utf8")).trim() === fingerprint;
  } catch {
    return false;
  }
}

function createSourceFingerprint(source: RepositorySource) {
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function serializeProjectSync<T>(projectId: number, task: () => Promise<T>): Promise<T> {
  const previous = repositorySyncs.get(projectId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  repositorySyncs.set(projectId, current);
  return current.finally(() => {
    if (repositorySyncs.get(projectId) === current) {
      repositorySyncs.delete(projectId);
    }
  });
}

function normalizeOptionalString(value: unknown, fieldName: string) {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new RepositorySourceError(`${fieldName} 必须是字符串`);
  }
  return value.trim() || null;
}

function validateBranch(branch: string) {
  if (branch.length > 255) {
    throw new RepositorySourceError("仓库分支不能超过 255 个字符");
  }
  const segments = branch.split("/");
  const hasForbiddenCharacter = [...branch].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127 || "~^:?*[\\".includes(character);
  });
  if (
    branch === "@"
    || branch.startsWith("-")
    || branch.endsWith(".")
    || branch.includes("..")
    || branch.includes("@{")
    || hasForbiddenCharacter
    || segments.some((segment) => !segment || segment.startsWith(".") || segment.endsWith(".lock"))
  ) {
    throw new RepositorySourceError(`仓库分支格式不合法：${branch}`);
  }
}

function normalizeSubdirectory(value: string) {
  if (value.length > 1000) {
    throw new RepositorySourceError("仓库子目录不能超过 1000 个字符");
  }
  const slashPath = value.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || /^[a-zA-Z]:\//u.test(slashPath)) {
    throw new RepositorySourceError("仓库子目录必须是相对路径");
  }

  const segments = slashPath.split("/");
  while (segments.at(-1) === "") segments.pop();
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new RepositorySourceError("仓库子目录不能包含空路径、. 或 ..");
  }
  if (segments.some(containsControlCharacter)) {
    throw new RepositorySourceError("仓库子目录包含非法控制字符");
  }
  return segments.join("/");
}

function containsControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
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

class GitCommandError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "GitCommandError";
  }
}

function runGit(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(new GitCommandError(`无法启动 Git：${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const detail = redactRepositoryLocations(stderr.trim()).slice(0, 1000);
        reject(new GitCommandError(detail || `Git 命令退出，code=${code ?? "null"}`));
      }
    });
  });
}

function formatGitDetail(error: unknown) {
  if (!(error instanceof GitCommandError) || !error.detail) return "";
  return ` Git 返回：${error.detail}`;
}

function redactRepositoryLocations(value: string) {
  return value
    .replace(/https?:\/\/[^\s'"]+/gu, "[仓库地址]")
    .replace(/\b[^\s'"]+@[^\s'"]+:[^\s'"]+/gu, "[仓库地址]");
}
