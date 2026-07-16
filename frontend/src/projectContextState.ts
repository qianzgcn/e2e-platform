import { createContext, useContext } from "react";
import type { ProjectConfig } from "./types";

export type ProjectContextValue = {
  projects: ProjectConfig[];
  currentProjectId: number | null;
  setCurrentProjectId: (id: number | null) => void;
  reloadProjects: () => Promise<void>;
  loading: boolean;
};

export const ProjectContextState = createContext<ProjectContextValue | null>(null);

export function useProject() {
  const context = useContext(ProjectContextState);
  if (!context) {
    throw new Error("useProject 必须在 ProjectProvider 内使用");
  }
  return context;
}
