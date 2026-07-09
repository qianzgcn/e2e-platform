import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchProjects } from "./api/project";
import type { ProjectConfig } from "./types";

const STORAGE_KEY = "currentProjectId";

type ProjectContextValue = {
  projects: ProjectConfig[];
  currentProjectId: number | null;
  setCurrentProjectId: (id: number | null) => void;
  reloadProjects: () => Promise<void>;
  loading: boolean;
};

const ProjectContext = createContext<ProjectContextValue | null>(null);

// 全局当前项目状态：顶部选择框切换，localStorage 持久化，所有页面按当前 projectId 加载数据。
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
    <ProjectContext.Provider value={{ projects, currentProjectId, setCurrentProjectId, reloadProjects, loading }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject() {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error("useProject 必须在 ProjectProvider 内使用");
  }
  return ctx;
}
