import type { ScriptSource } from "./agentService.js";
import type { ProjectAutomationAdapter } from "../types/projectAutomation.js";
import type { TestCaseRunStatus } from "../utils/runStatus.js";

export type SharedRunningStatus = "queued" | "generating" | "running" | "success" | "failed";

export type ProjectVariable = {
  name: string;
  value: string;
};

export type ProjectConfig = {
  baseUrl: string;
  repoUrl: string | null;
  repoBranch: string | null;
  repoSubdirectory: string | null;
  promptHint: string | null;
  automationHint: string | null;
  automationAdapter: ProjectAutomationAdapter | null;
  variables: ProjectVariable[];
};

export type RunTargetTestCase = {
  id: string;
  title: string;
  projectId: number;
  naturalLanguage: string;
  status: TestCaseRunStatus;
  playwrightScript: string | null;
  scriptNeedsGeneration: boolean;
  scriptGeneratedAt: Date | null;
};

export type RunTask = {
  runLogId: number;
  kind: "execution" | "repair";
  testCase: RunTargetTestCase;
  // 提交时的项目配置快照，生成和执行都以此为准，避免 worker 反复查库。
  baseUrl: string;
  projectInstructions: string | null;
  automationInstructions: string | null;
  automationAdapter: ProjectAutomationAdapter | null;
  logWriter?: {
    lines: string[];
    pending: Promise<void>;
  };
};

export type ScriptGenerationItem = {
  kind: "generation";
  task: RunTask;
  source: ScriptSource;
};

export type RepairItem = {
  kind: "repair";
  task: RunTask;
  project: ProjectConfig;
  sourceRunLog: {
    id: number;
    failureReason: string | null;
    stdout: string | null;
    stderr: string | null;
  };
  sourceEditedAt: Date;
  groupName: string;
};

export type GenerationItem = ScriptGenerationItem | RepairItem;

export type StopTarget = {
  runLogId: number;
  testCaseId: string;
  kind: RunTask["kind"];
  logs?: string;
};

export type StopRunResult = {
  stopped: boolean;
  affectedTestCaseIds: string[];
};

export type GenerationControl = {
  controller: AbortController;
  tasks: RunTask[];
};

export type PlaywrightControl = {
  controller: AbortController;
  task: RunTask;
};
