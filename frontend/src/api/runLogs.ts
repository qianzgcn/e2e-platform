import { request } from "./client";
import type { RunLog } from "../types";

export function fetchRunLog(id: number) {
  return request<RunLog>(`/run-logs/${id}`);
}

