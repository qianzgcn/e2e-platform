import { Tag } from "antd";
import type { TestCaseStatus } from "../types";

const statusMap: Record<TestCaseStatus, { text: string; color: string }> = {
  not_run: { text: "未运行", color: "default" },
  queued: { text: "排队中", color: "processing" },
  generating: { text: "用例生成中", color: "gold" },
  running: { text: "运行中", color: "blue" },
  success: { text: "成功", color: "green" },
  failed: { text: "失败", color: "red" },
};

export function StatusTag({ status }: { status: TestCaseStatus }) {
  const config = statusMap[status];
  return <Tag color={config.color}>{config.text}</Tag>;
}

export function isBusyStatus(status: TestCaseStatus) {
  return status === "queued" || status === "generating" || status === "running";
}

