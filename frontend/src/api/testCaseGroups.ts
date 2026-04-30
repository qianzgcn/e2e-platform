import { request } from "./client";
import type { TestCaseGroup } from "../types";

export function fetchTestCaseGroups() {
  return request<TestCaseGroup[]>("/test-case-groups");
}

export function createTestCaseGroup(name: string) {
  return request<TestCaseGroup>("/test-case-groups", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function deleteTestCaseGroup(id: number) {
  return request<void>(`/test-case-groups/${id}`, {
    method: "DELETE",
  });
}
