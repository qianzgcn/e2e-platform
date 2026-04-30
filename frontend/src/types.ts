export type TestCaseStatus = "not_run" | "queued" | "generating" | "running" | "success" | "failed";

export type RunLogStatus = "queued" | "generating" | "running" | "success" | "failed";

export type TestCaseListItem = {
  id: string;
  title: string;
  groupId: number;
  groupName: string;
  status: TestCaseStatus;
  lastFailureReason?: string | null;
  lastRunAt?: string | null;
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
  playwrightScript?: string;
};

export type TestCaseGroup = {
  id: number;
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
    failureReason: string;
  }>;
};

export type ProjectConfig = {
  id: number;
  name: string;
  baseUrl: string;
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
