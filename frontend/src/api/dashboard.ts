import { request } from "./client";
import type { DashboardData } from "../types";

export function fetchDashboard(projectId: number) {
  return request<DashboardData>(`/dashboard?projectId=${projectId}`);
}

