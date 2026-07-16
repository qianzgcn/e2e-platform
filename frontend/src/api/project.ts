import { request } from "./client";
import type { ProjectConfig } from "../types";

export type ProjectPayload = Pick<
  ProjectConfig,
  | "name"
  | "baseUrl"
  | "repoUrl"
  | "repoBranch"
  | "repoSubdirectory"
  | "promptHint"
  | "automationHint"
  | "automationAdapterKey"
  | "variables"
>;

export type RepositorySourcePayload = Pick<ProjectConfig, "repoUrl" | "repoBranch" | "repoSubdirectory">;

export function fetchProjects() {
  return request<ProjectConfig[]>("/project");
}

export function fetchProject(id: number) {
  return request<ProjectConfig>(`/project/${id}`);
}

export function fetchAutomationAdapters() {
  return request<string[]>("/project/automation-adapters");
}

export function createProject(data: ProjectPayload) {
  return request<ProjectConfig>("/project", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateProject(id: number, data: ProjectPayload) {
  return request<ProjectConfig>(`/project/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteProject(id: number) {
  return request<void>(`/project/${id}`, {
    method: "DELETE",
  });
}

export function testRepoConnectivity(source: RepositorySourcePayload) {
  return request<{ ok: boolean; message: string }>("/project/test-repo", {
    method: "POST",
    body: JSON.stringify(source),
  });
}
