import type { TestCaseStatus } from "../types";

export function isBusyStatus(status: TestCaseStatus) {
  return status === "queued" || status === "generating" || status === "running";
}
