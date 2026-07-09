import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resetPlaywrightTestResults } from "./cleanupService.js";

const MAX_PLAYWRIGHT_OUTPUT_BUFFER = 1024 * 1024 * 10;

export type PlaywrightResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  failureReason?: string;
};

type RunPlaywrightOptions = {
  signal?: AbortSignal;
  stopReason?: string;
};

type PlaywrightInvocation = {
  command: string;
  args: string[];
};

// 写入指定用例的 spec 文件，并调用 Playwright 执行。
export async function runPlaywright(
  script: string,
  baseUrl: string,
  testCaseId: string,
  options: RunPlaywrightOptions = {},
): Promise<PlaywrightResult> {
  logRunner("准备执行 Playwright", { testCaseId, baseUrl });
  const generatedDir = path.resolve(process.cwd(), "tests", "generated");
  await mkdir(generatedDir, { recursive: true });

  // 生成文件固定使用用例 id 命名，避免标题变更后留下旧文件。
  const specFileName = `${testCaseId}.spec.ts`;
  const specPath = path.join(generatedDir, specFileName);

  await writeFile(specPath, script, "utf8");
  logRunner("写入 Playwright spec 文件", { testCaseId, specPath, scriptLength: script.length });

  // 每个用例只保留最新一次产物，运行前先清空该用例自己的结果目录。
  const testResultsDir = await resetPlaywrightTestResults(testCaseId);
  logRunner("重建 Playwright 产物目录", { testCaseId, testResultsDir });

  try {
    // Playwright 的退出码就是运行结果：0 表示通过，非 0 表示失败或执行异常。
    const specRelativePath = path.relative(process.cwd(), specPath).replaceAll(path.sep, "/");
    const invocation = createPlaywrightInvocation(specRelativePath);
    logRunner("执行 Playwright 命令", {
      testCaseId,
      command: formatCommand(invocation.command, invocation.args),
      env: {
        PLAYWRIGHT_BASE_URL: baseUrl,
        PLAYWRIGHT_TEST_CASE_ID: testCaseId,
      },
    });
    const { stdout, stderr } = await runPlaywrightCommand(invocation, baseUrl, testCaseId, options);

    logRunner("Playwright 执行成功", {
      testCaseId,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
    });
    return { success: true, stdout, stderr };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const stderr = result.stderr ?? "";
    const stdout = result.stdout ?? "";
    const stopped = options.signal?.aborted || result.killed;
    const failureReason = stopped
      ? options.stopReason ?? result.message ?? "Playwright 已被终止"
      : stderr || stdout || result.message || "Playwright 运行失败";

    logRunner("Playwright 执行失败", {
      testCaseId,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
      failureReason,
    });
    return {
      success: false,
      stdout,
      stderr,
      failureReason,
    };
  }
}

function createPlaywrightInvocation(specRelativePath: string): PlaywrightInvocation {
  return {
    command: "npm",
    args: ["run", "test:generated", "--", specRelativePath],
  };
}

function runPlaywrightCommand(
  invocation: PlaywrightInvocation,
  baseUrl: string,
  testCaseId: string,
  options: RunPlaywrightOptions,
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      // 单独进程组方便停止时同时终止 npm、Playwright 和浏览器子进程。
      detached: true,
      shell: false,
      env: {
        ...process.env,
        PLAYWRIGHT_BASE_URL: baseUrl,
        PLAYWRIGHT_TEST_CASE_ID: testCaseId,
      },
    });

    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
    };

    const rejectOnce = (error: Error & { stdout?: string; stderr?: string; killed?: boolean }) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = () => {
      killProcess(child);
      rejectOnce(toPlaywrightError(options.stopReason ?? "Playwright 已被终止", stdout, stderr, true));
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length + stderr.length > MAX_PLAYWRIGHT_OUTPUT_BUFFER) {
        killProcess(child);
        rejectOnce(toPlaywrightError("Playwright 输出超过限制，已终止执行", stdout, stderr, true));
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stdout.length + stderr.length > MAX_PLAYWRIGHT_OUTPUT_BUFFER) {
        killProcess(child);
        rejectOnce(toPlaywrightError("Playwright 输出超过限制，已终止执行", stdout, stderr, true));
      }
    });

    child.on("error", (error) => {
      rejectOnce(toPlaywrightError(error.message, stdout, stderr));
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(toPlaywrightError(`Playwright 退出码异常: ${code ?? "null"}`, stdout, stderr, false));
    });
  });
}

function toPlaywrightError(message: string, stdout: string, stderr: string, killed = false) {
  return Object.assign(new Error(message), {
    stdout,
    stderr,
    killed,
  });
}

function killProcess(child: ChildProcessWithoutNullStreams) {
  if (!child.pid) {
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

// 给命令行参数加双引号，避免路径里的空格影响执行。
function quoteArg(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function formatCommand(command: string, args: string[]) {
  return [command, ...args.map(quoteArg)].join(" ");
}

// 输出 Playwright runner 日志。
function logRunner(message: string, data?: unknown) {
  console.log(`[runnerService] ${message}`, data ?? "");
}
