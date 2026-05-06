import { request } from "./client";
import type { ProjectConfig } from "../types";

export function fetchProject() {
  return request<ProjectConfig | null>("/project");
}

export function saveProject(data: Pick<ProjectConfig, "name" | "baseUrl" | "variables">) {
  return request<ProjectConfig>("/project", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}
