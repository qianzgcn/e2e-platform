import { access, readdir } from "node:fs/promises";
import path from "node:path";

const TEST_RESULTS_ROOT = path.resolve(process.cwd(), "test-results");

export type ArtifactItem = {
  name: string;
  type: "video" | "report" | "other";
  url: string;
};

// 获取指定用例最新一次运行的报告和附件。
export async function getLatestArtifacts(testCaseId: string) {
  // 运行产物不入库；接口每次都从该用例的最新 test-results 目录读取。
  const rootDir = path.join(TEST_RESULTS_ROOT, testCaseId);
  const reportPath = path.join(rootDir, "html-report", "index.html");

  const [reportExists, artifacts] = await Promise.all([
    exists(reportPath),
    scanArtifacts(rootDir, rootDir),
  ]);

  return {
    reportUrl: reportExists ? toArtifactUrl(reportPath) : undefined,
    artifacts,
  };
}

// 递归扫描用例产物目录。
async function scanArtifacts(rootDir: string, currentDir: string): Promise<ArtifactItem[]> {
  // 用例未运行过时目录不存在，前端展示“暂无运行日志”即可。
  if (!(await exists(currentDir))) {
    return [];
  }

  const entries = await readdir(currentDir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        return scanArtifacts(rootDir, fullPath);
      }

      return [
        {
          name: path.relative(rootDir, fullPath).replaceAll(path.sep, "/"),
          type: getArtifactType(fullPath),
          url: toArtifactUrl(fullPath),
        },
      ];
    }),
  );

  return nested.flat();
}

// 判断文件或目录是否存在。
async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// 根据文件后缀识别产物类型。
function getArtifactType(filePath: string): ArtifactItem["type"] {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (fileName === "index.html") return "report";
  if (ext === ".webm" || ext === ".mp4") return "video";
  return "other";
}

// 将本地 test-results 文件路径转换为前端可访问的静态资源 URL。
function toArtifactUrl(filePath: string) {
  const relativePath = path.relative(TEST_RESULTS_ROOT, filePath).replaceAll(path.sep, "/");
  return `/test-results/${relativePath}`;
}
