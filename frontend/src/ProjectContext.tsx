import { useCallback, useEffect, useState, type ReactNode } from "react";
import { fetchProjects } from "./api/project";
import type { ProjectConfig } from "./types";
import { ProjectContextState } from "./projectContextState";

const STORAGE_KEY = "currentProjectId";

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentProjectId, setCurrentProjectIdState] = useState<number | null>(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const parsed = stored ? Number(stored) : NaN;
    return Number.isInteger(parsed) ? parsed : null;
  });

  const reloadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchProjects();
      setProjects(list);
      // 当前项目失效或未选时，回落到第一个项目。
      setCurrentProjectIdState((prev) => {
        const valid = prev != null && list.some((project) => project.id === prev);
        if (valid) {
          return prev;
        }
        const next = list.length ? list[0].id : null;
        if (next == null) {
          window.localStorage.removeItem(STORAGE_KEY);
        } else {
          window.localStorage.setItem(STORAGE_KEY, String(next));
        }
        return next;
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadProjects();
  }, [reloadProjects]);

  const setCurrentProjectId = useCallback((id: number | null) => {
    setCurrentProjectIdState(id);
    if (id == null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, String(id));
    }
  }, []);

  return (
    <ProjectContextState.Provider value={{ projects, currentProjectId, setCurrentProjectId, reloadProjects, loading }}>
      {children}
    </ProjectContextState.Provider>
  );
}
