import { request } from "./client";
import type { DashboardData } from "../types";

export function fetchDashboard() {
  return request<DashboardData>("/dashboard");
}

