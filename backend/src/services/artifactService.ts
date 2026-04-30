import { access, readdir } from "node:fs/promises";
import path from "node:path";

export type ArtifactItem = {
  name: string;
  type: "video" | "report" | "other";
  url: string;
};

export async function getLatestArtifacts(testCaseId: string) {
  const rootDir = path.resolve(process.cwd(), "test-results", testCaseId);
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

async function scanArtifacts(rootDir: string, currentDir: string): Promise<ArtifactItem[]> {
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

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getArtifactType(filePath: string): ArtifactItem["type"] {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (fileName === "index.html") return "report";
  if (ext === ".webm" || ext === ".mp4") return "video";
  return "other";
}

function toArtifactUrl(filePath: string) {
  const relativePath = path.relative(path.resolve(process.cwd(), "test-results"), filePath).replaceAll(path.sep, "/");
  return `/test-results/${relativePath}`;
}
