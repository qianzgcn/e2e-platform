import { mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "@playwright/test";

const FRAME_RATIOS = [0.05, 0.25, 0.5, 0.75, 0.95];
const REPAIR_WORK_ROOT = path.resolve(process.cwd(), ".repair-work");

export async function extractRepairVideoFrames(repairLogId: number, videoPaths: string[]) {
  const outputDir = path.join(REPAIR_WORK_ROOT, String(repairLogId), "video-frames");
  await rm(outputDir, { recursive: true, force: true });
  if (!videoPaths.length) {
    return [];
  }
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true, chromiumSandbox: false });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(pathToFileURL(videoPaths[0]).href, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const video = page.locator("video");
    await video.waitFor({ state: "visible", timeout: 10_000 });
    const duration = await video.evaluate((element: HTMLVideoElement) => element.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("录屏时长无效");
    }

    const frames: string[] = [];
    for (const [index, ratio] of FRAME_RATIOS.entries()) {
      const time = Math.min(Math.max(duration * ratio, 0), Math.max(duration - 0.05, 0));
      await video.evaluate(async (element: HTMLVideoElement, nextTime: number) => {
        if (Math.abs(element.currentTime - nextTime) < 0.01) {
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error("录屏定位超时")), 5000);
          element.addEventListener("seeked", () => {
            window.clearTimeout(timeout);
            resolve();
          }, { once: true });
          element.currentTime = nextTime;
        });
      }, time);
      const framePath = path.join(outputDir, `frame-${index + 1}.png`);
      await video.screenshot({ path: framePath });
      frames.push(framePath);
    }
    return frames;
  } finally {
    await browser.close();
  }
}

export async function removeRepairWorkspace(repairLogId: number) {
  await rm(path.join(REPAIR_WORK_ROOT, String(repairLogId)), { recursive: true, force: true });
}
