import { request } from "./client";
import type { LatestRunDetail, TestCaseDetail, TestCaseListItem, TestCasePayload } from "../types";

export function fetchTestCases(title?: string) {
  const query = title ? `?title=${encodeURIComponent(title)}` : "";
  return request<TestCaseListItem[]>(`/test-cases${query}`);
}

export function fetchTestCase(id: string) {
  return request<TestCaseDetail>(`/test-cases/${id}`);
}

export function fetchLatestRun(id: string) {
  return request<LatestRunDetail>(`/test-cases/${id}/latest-run`);
}

export function createTestCase(data: TestCasePayload) {
  return request<TestCaseDetail>("/test-cases", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateTestCase(id: string, data: TestCasePayload) {
  return request<TestCaseDetail>(`/test-cases/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteTestCase(id: string) {
  return request<void>(`/test-cases/${id}`, {
    method: "DELETE",
  });
}

export function runTestCase(id: string) {
  return request<{ runId: number }>(`/test-cases/${id}/run`, {
    method: "POST",
  });
}

export function deleteTestCases(ids: string[]) {
  return deleteTestCase(ids.join(","));
}

export function runTestCases(ids: string[]) {
  return request<{ runIds: number[] }>(`/test-cases/${ids.join(",")}/run`, {
    method: "POST",
  });
}
