export type TestCaseStatus = "not_run" | "queued" | "generating" | "running" | "success" | "failed";
export type ActiveTestCaseStatus = Extract<TestCaseStatus, "queued" | "generating" | "running">;

export type RunLogStatus = "queued" | "generating" | "running" | "success" | "failed";
export type RunLogKind = "execution" | "repair";

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
  activeRunKind?: RunLogKind | null;
  pendingRepairCandidateId?: number | null;
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
  kind: "generated" | "repair";
  generationId: number | null;
  repairRunLogId: number | null;
  targetTestCaseId: string | null;
  title: string;
  groupName: string;
  naturalLanguage: string;
  sourceNaturalLanguage: string | null;
  sourceEditedAt: string | null;
  repairProblem: string | null;
  repairSuggestion: string | null;
  status: "pending" | "imported" | "rejected";
  stale: boolean;
  createdAt: string;
};

export type TestCaseGenerationStatus = "running" | "success" | "failed";

export type TestCaseGenerationSummary = {
  id: number;
  projectId: number;
  status: TestCaseGenerationStatus;
  hint: string | null;
  failureReason: string | null;
  candidateCount: number;
  createdAt: string;
  finishedAt: string | null;
};

export type TestCaseGeneration = TestCaseGenerationSummary & {
  logs: string;
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
  automationHint?: string | null;
  automationAdapterKey?: string | null;
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
  kind: RunLogKind;
  status: RunLogStatus;
  failureReason?: string | null;
  logs?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  sourceRunLogId?: number | null;
  startedAt: string;
  finishedAt?: string | null;
  repairCandidate?: RepairCandidateReference | null;
};

export type RepairCandidateReference = {
  id: number;
  status: "pending" | "imported" | "rejected";
  naturalLanguage?: string;
  sourceNaturalLanguage?: string | null;
  repairProblem?: string | null;
  repairSuggestion?: string | null;
};

export type RunLogSummary = Pick<
  RunLog,
  "id" | "testCaseId" | "kind" | "status" | "sourceRunLogId" | "startedAt" | "finishedAt"
> & {
  repairCandidate: Pick<RepairCandidateReference, "id" | "status"> | null;
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

export type TestCaseLogHistory = {
  logs: RunLogSummary[];
  total: number;
  page: number;
  pageSize: number;
};

export type TestCaseLogDetail = {
  runLog: RunLog;
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
