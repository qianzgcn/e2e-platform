import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  ensureRepo,
  normalizeRepositorySource,
  testRepoConnectivity,
} from "../../src/infra/repoService.js";

const execFileAsync = promisify(execFile);

test("repository source normalizes optional scope and rejects unsafe values", () => {
  assert.equal(normalizeRepositorySource({ repoUrl: "  " }), null);
  assert.deepEqual(normalizeRepositorySource({
    repoUrl: " https://example.com/team/project.git ",
    repoBranch: " main ",
    repoSubdirectory: " examples\\todomvc/ ",
  }), {
    repoUrl: "https://example.com/team/project.git",
    repoBranch: "main",
    repoSubdirectory: "examples/todomvc",
  });

  for (const repoSubdirectory of ["/absolute", "C:\\absolute", "../outside", "src/../outside", "src//app"]) {
    assert.throws(
      () => normalizeRepositorySource({ repoUrl: "repository", repoSubdirectory }),
      /相对路径|不能包含/,
    );
  }
  for (const repoBranch of ["-main", "feature..name", "feature name", ".hidden", "release.lock"]) {
    assert.throws(
      () => normalizeRepositorySource({ repoUrl: "repository", repoBranch }),
      /分支格式不合法/,
    );
  }
  assert.throws(
    () => normalizeRepositorySource({ repoBranch: "main" }),
    /请先填写代码仓库 URL/,
  );
  assert.throws(
    () => normalizeRepositorySource({ repoUrl: "--upload-pack=unexpected" }),
    /代码仓库 URL 不能以 - 开头/,
  );
});

test("repository sync supports full and sparse checkouts and invalidates changed sources", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "e2e-platform-repo-test-"));
  const first = await createRepositoryFixture(fixtureRoot, "first", {
    "README.md": "first repository",
    "app/version.txt": "v1",
    "sibling/hidden.txt": "must not be checked out",
  });
  const second = await createRepositoryFixture(fixtureRoot, "second", {
    "other/value.txt": "second repository",
    "sibling/hidden.txt": "also hidden",
  });
  const projectId = 1_000_000_000 + randomInt(1_000_000);
  const sparseProjectId = projectId + 1;

  t.after(async () => {
    await Promise.all([
      removeRepositoryCache(projectId),
      removeRepositoryCache(sparseProjectId),
      rm(fixtureRoot, { recursive: true, force: true }),
    ]);
  });

  const fullRoot = await ensureRepo({
    repoUrl: first.url,
    repoBranch: "main",
    repoSubdirectory: null,
  }, projectId);
  assert.equal(await fileExists(path.join(fullRoot, "sibling", "hidden.txt")), true);

  const sparseRoot = await ensureRepo({
    repoUrl: first.url,
    repoBranch: "main",
    repoSubdirectory: "app",
  }, sparseProjectId);
  assert.equal(path.basename(sparseRoot), "app");
  assert.equal(await readFile(path.join(sparseRoot, "version.txt"), "utf8"), "v1");
  assert.equal(await fileExists(path.join(path.dirname(sparseRoot), "sibling")), false);

  await writeFile(path.join(first.worktree, "app", "version.txt"), "v2", "utf8");
  await git(first.worktree, ["add", "."]);
  await git(first.worktree, ["commit", "-m", "update app"]);
  await git(first.worktree, ["push", "origin", "main"]);
  await ensureRepo({
    repoUrl: first.url,
    repoBranch: "main",
    repoSubdirectory: "app",
  }, sparseProjectId);
  assert.equal(await readFile(path.join(sparseRoot, "version.txt"), "utf8"), "v2");

  const changedRoot = await ensureRepo({
    repoUrl: second.url,
    repoBranch: "main",
    repoSubdirectory: "other",
  }, sparseProjectId);
  assert.equal(await readFile(path.join(changedRoot, "value.txt"), "utf8"), "second repository");
  assert.equal(await fileExists(path.join(path.dirname(changedRoot), "app")), false);

  await testRepoConnectivity({
    repoUrl: first.url,
    repoBranch: "main",
    repoSubdirectory: "app",
  });
  await assert.rejects(
    () => testRepoConnectivity({ repoUrl: first.url, repoBranch: "missing", repoSubdirectory: null }),
    /不存在或无法访问分支 missing/,
  );
  await assert.rejects(
    () => testRepoConnectivity({ repoUrl: first.url, repoBranch: "main", repoSubdirectory: "missing" }),
    /仓库中不存在目录 missing/,
  );
});

async function createRepositoryFixture(
  fixtureRoot: string,
  name: string,
  files: Record<string, string>,
) {
  const worktree = path.join(fixtureRoot, `${name}-worktree`);
  const bareRepository = path.join(fixtureRoot, `${name}.git`);
  await mkdir(worktree, { recursive: true });
  await git(worktree, ["init", "--initial-branch=main"]);
  await git(worktree, ["config", "user.email", "tests@example.com"]);
  await git(worktree, ["config", "user.name", "Repository Tests"]);

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(worktree, ...relativePath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  }
  await git(worktree, ["add", "."]);
  await git(worktree, ["commit", "-m", "initial fixture"]);
  await git(fixtureRoot, ["clone", "--bare", worktree, bareRepository]);
  await git(bareRepository, ["config", "uploadpack.allowFilter", "true"]);
  await git(worktree, ["remote", "add", "origin", bareRepository]);

  return {
    worktree,
    url: pathToFileURL(bareRepository).href,
  };
}

async function removeRepositoryCache(projectId: number) {
  const cacheRoot = path.resolve(process.cwd(), ".repos");
  await Promise.all([
    rm(path.join(cacheRoot, String(projectId)), { recursive: true, force: true }),
    rm(path.join(cacheRoot, `${projectId}.source`), { force: true }),
  ]);
}

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}
