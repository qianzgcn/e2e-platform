import { access, readdir } from "node:fs/promises";
import path from "node:path";

const TEST_RESULTS_ROOT = path.resolve(process.cwd(), "test-results");

export type ArtifactItem = {
  name: string;
  type: "video" | "report" | "other";
  url: string;
};

export type ArtifactEvidenceItem = ArtifactItem & {
  filePath: string;
};

// 获取指定运行批次的报告和附件。
export async function getRunArtifacts(testCaseId: string, runLogId: number) {
  const evidence = await getRunArtifactEvidence(testCaseId, runLogId);
  return {
    reportUrl: evidence.reportUrl,
    artifacts: evidence.artifacts.map(({ filePath: _filePath, ...artifact }) => artifact),
  };
}

// 修复服务使用绝对路径读取失败证据；API 返回值会在 getRunArtifacts 中移除本地路径。
export async function getRunArtifactEvidence(testCaseId: string, runLogId: number) {
  const rootDir = path.join(TEST_RESULTS_ROOT, testCaseId, String(runLogId));
  const reportPath = path.join(rootDir, "html-report", "index.html");

  const [reportExists, scannedArtifacts] = await Promise.all([
    exists(reportPath),
    scanArtifacts(rootDir, rootDir),
  ]);

  return {
    reportUrl: reportExists ? toArtifactUrl(reportPath) : undefined,
    reportPath: reportExists ? reportPath : undefined,
    artifacts: removeCopiedReportVideos(scannedArtifacts),
  };
}

// HTML reporter 会把原始失败视频复制到 html-report/data；有原始附件时只展示一份。
function removeCopiedReportVideos(artifacts: ArtifactEvidenceItem[]) {
  const hasOriginalVideo = artifacts.some(
    (artifact) => artifact.type === "video" && !artifact.name.startsWith("html-report/"),
  );
  return hasOriginalVideo
    ? artifacts.filter((artifact) => artifact.type !== "video" || !artifact.name.startsWith("html-report/"))
    : artifacts;
}

// 递归扫描用例产物目录。
async function scanArtifacts(rootDir: string, currentDir: string): Promise<ArtifactEvidenceItem[]> {
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
          filePath: fullPath,
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
