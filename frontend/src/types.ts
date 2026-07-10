export type TestCaseStatus = "not_run" | "queued" | "generating" | "running" | "success" | "failed";
export type ActiveTestCaseStatus = Extract<TestCaseStatus, "queued" | "generating" | "running">;

export type RunLogStatus = "queued" | "generating" | "running" | "success" | "failed";

export type TestCaseListItem = {
  id: string;
  title: string;
  groupId: number;
  projectId: number;
  groupName: string;
  status: TestCaseStatus;
  scriptNeedsGeneration: boolean;
  lastFailureReason?: string | null;
  lastRunAt?: string | null;
  createdAt?: string | null;
  editedAt?: string | null;
};

export type TestCaseDetail = TestCaseListItem & {
  naturalLanguage: string;
  playwrightScript?: string | null;
};

export type TestCasePayload = {
  title: string;
  groupId: number;
  naturalLanguage: string;
  scriptNeedsGeneration?: boolean;
  playwrightScript?: string;
};

export type TestCaseExcelRow = {
  title: string;
  groupName: string;
  naturalLanguage: string;
};

export type TestCaseCandidate = {
  id: number;
  projectId: number;
  generationId: number;
  title: string;
  groupName: string;
  naturalLanguage: string;
  status: "pending" | "imported";
  createdAt: string;
};

export type TestCaseGeneration = {
  id: number;
  projectId: number;
  logs: string;
  hint: string | null;
  createdAt: string;
};

export type TestCaseImportResult = {
  createdCount: number;
  skippedCount: number;
  createdIds: string[];
  skippedRows: Array<
    Partial<TestCaseExcelRow> & {
      rowNumber?: number;
      reason: string;
    }
  >;
};

export type TestCaseGroup = {
  id: number;
  projectId: number;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type DashboardData = {
  successRate: number;
  totalCases: number;
  recentFailedCases: Array<{
    id: string;
    title: string;
    groupName: string;
    lastRunAt?: string | null;
  }>;
};

export type ProjectConfig = {
  id: number;
  name: string;
  baseUrl: string;
  repoUrl?: string | null;
  promptHint?: string | null;
  variables: ProjectVariable[];
};

export type ProjectVariable = {
  id?: number;
  name: string;
  value: string;
  description?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type RunLog = {
  id: number;
  testCaseId: string;
  status: RunLogStatus;
  failureReason?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  startedAt: string;
  finishedAt?: string | null;
};

export type RunArtifact = {
  name: string;
  type: "video" | "report" | "other";
  url: string;
};

export type LatestRunDetail = {
  runLog?: RunLog | null;
  reportUrl?: string;
  artifacts: RunArtifact[];
};

export type SkippedRunCase = {
  id: string;
  title: string;
  status: ActiveTestCaseStatus;
};

export type RunRequestResult = {
  runIds: number[];
  skippedCases: SkippedRunCase[];
};

export type StopRunResult = {
  stopped: boolean;
  affectedTestCaseIds: string[];
};
