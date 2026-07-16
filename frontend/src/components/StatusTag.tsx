import { Tag } from "antd";
import type { RunLogKind, TestCaseStatus } from "../types";

const statusMap: Record<TestCaseStatus, { text: string; color: string }> = {
  not_run: { text: "未运行", color: "default" },
  queued: { text: "排队中", color: "processing" },
  generating: { text: "用例生成中", color: "gold" },
  running: { text: "运行中", color: "blue" },
  success: { text: "成功", color: "green" },
  failed: { text: "失败", color: "red" },
};

const repairStatusMap: Partial<Record<TestCaseStatus, { text: string; color: string }>> = {
  queued: { text: "修复排队中", color: "processing" },
  generating: { text: "AI 修复中", color: "gold" },
  running: { text: "修复验证中", color: "blue" },
};

export function StatusTag({ status, kind }: { status: TestCaseStatus; kind?: RunLogKind | null }) {
  const config = kind === "repair" ? repairStatusMap[status] ?? statusMap[status] : statusMap[status];
  return <Tag color={config.color}>{config.text}</Tag>;
}
