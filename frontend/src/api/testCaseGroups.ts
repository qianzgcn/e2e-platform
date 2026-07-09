import { request } from "./client";
import type { TestCaseGroup } from "../types";

export function fetchTestCaseGroups(projectId: number) {
  return request<TestCaseGroup[]>(`/test-case-groups?projectId=${projectId}`);
}

export function createTestCaseGroup(projectId: number, name: string) {
  return request<TestCaseGroup>("/test-case-groups", {
    method: "POST",
    body: JSON.stringify({ projectId, name }),
  });
}

export function deleteTestCaseGroup(id: number) {
  return request<void>(`/test-case-groups/${id}`, {
    method: "DELETE",
  });
}
