import { Router, type Response } from "express";
import { prisma } from "../infra/prisma.js";
import {
  listProjectAutomationAdapters,
  ProjectAutomationAdapterError,
  resolveProjectAutomationAdapter,
} from "../infra/projectAutomationAdapter.js";
import {
  normalizeRepositorySource,
  RepositorySourceError,
  testRepoConnectivity,
} from "../infra/repoService.js";
import { ACTIVE_STATUSES } from "../utils/runStatus.js";

export const projectRouter = Router();

const projectInclude = {
  variables: {
    orderBy: {
      id: "asc",
    },
  },
} as const;

type ProjectVariableInput = {
  name: string;
  value: string;
  description?: string | null;
};

function normalizeVariables(raw: unknown) {
  return ((raw ?? []) as ProjectVariableInput[]).map((variable) => ({
    name: variable.name.trim(),
    value: variable.value,
    description: variable.description?.trim() || null,
  }));
}

// 列出所有项目（带变量）。
projectRouter.get("/", async (_req, res) => {
  const projects = await prisma.project.findMany({
    orderBy: { id: "asc" },
    include: projectInclude,
  });
  res.json(projects);
});

// 新建项目（项目名唯一）。
projectRouter.post("/", async (req, res) => {
  const { name, baseUrl, promptHint, automationHint } = req.body;
  const variables = normalizeVariables(req.body.variables);

  if (!name || !baseUrl) {
    res.status(400).json({ message: "项目名称和 baseUrl 必填" });
    return;
  }

  try {
    const repository = normalizeRepositorySource(req.body);
    const automationAdapterKey = await normalizeAutomationAdapterKey(req.body.automationAdapterKey);
    const project = await prisma.project.create({
      data: {
        name,
        baseUrl,
        repoUrl: repository?.repoUrl ?? null,
        repoBranch: repository?.repoBranch ?? null,
        repoSubdirectory: repository?.repoSubdirectory ?? null,
        promptHint: promptHint || null,
        automationHint: automationHint || null,
        automationAdapterKey,
        variables: { create: variables },
      },
      include: projectInclude,
    });
    res.status(201).json(project);
  } catch (error) {
    sendProjectWriteError(res, error);
  }
});

// 列出平台源码中已安装且入口完整的项目级自动化 Adapter。
projectRouter.get("/automation-adapters", async (_req, res) => {
  res.json(await listProjectAutomationAdapters());
});

// 测试仓库、分支及可选子目录；临时检出不会写入项目缓存。
projectRouter.post("/test-repo", async (req, res) => {
  try {
    const repository = normalizeRepositorySource(req.body);
    if (!repository) {
      res.status(400).json({ message: "请输入代码仓库 URL" });
      return;
    }
    await testRepoConnectivity(repository);
    res.json({ ok: true, message: "仓库、分支和子目录均可访问" });
  } catch (error) {
    res.json({ ok: false, message: error instanceof Error ? error.message : "无法访问仓库" });
  }
});

projectRouter.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const project = await prisma.project.findUnique({ where: { id }, include: projectInclude });
  if (!project) {
    res.status(404).json({ message: "项目不存在" });
    return;
  }
  res.json(project);
});

projectRouter.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { name, baseUrl, promptHint, automationHint } = req.body;
  const variables = normalizeVariables(req.body.variables);

  if (!name || !baseUrl) {
    res.status(400).json({ message: "项目名称和 baseUrl 必填" });
    return;
  }

  try {
    const repository = normalizeRepositorySource(req.body);
    const automationAdapterKey = await normalizeAutomationAdapterKey(req.body.automationAdapterKey);
    const existing = await prisma.project.findUnique({
      where: { id },
      select: { automationAdapterKey: true },
    });
    if (!existing) {
      res.status(404).json({ message: "项目不存在" });
      return;
    }

    const adapterChanged = existing.automationAdapterKey !== automationAdapterKey;
    if (adapterChanged) {
      const activeTestCaseCount = await prisma.testCase.count({
        where: { projectId: id, status: { in: ACTIVE_STATUSES } },
      });
      if (activeTestCaseCount > 0) {
        res.status(409).json({ message: "项目仍有运行、生成或修复任务，结束后才能切换自动化 Adapter" });
        return;
      }
    }

    const project = await prisma.$transaction(async (tx) => {
      const updatedProject = await tx.project.update({
        where: { id },
        data: {
          name,
          baseUrl,
          repoUrl: repository?.repoUrl ?? null,
          repoBranch: repository?.repoBranch ?? null,
          repoSubdirectory: repository?.repoSubdirectory ?? null,
          promptHint: promptHint || null,
          automationHint: automationHint || null,
          automationAdapterKey,
          variables: { deleteMany: {}, create: variables },
        },
        include: projectInclude,
      });

      if (adapterChanged) {
        await tx.testCase.updateMany({
          where: { projectId: id },
          data: {
            playwrightScript: null,
            scriptNeedsGeneration: true,
            status: "not_run",
            lastFailureReason: null,
            scriptGeneratedAt: null,
          },
        });
      }

      return updatedProject;
    });
    res.json(project);
  } catch (error) {
    sendProjectWriteError(res, error);
  }
});

// 删除项目；项目下有用例时拒绝。
projectRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const caseCount = await prisma.testCase.count({ where: { projectId: id } });
  if (caseCount > 0) {
    res.status(400).json({ message: "该项目下有用例，不能删除" });
    return;
  }
  await prisma.project.delete({ where: { id } });
  res.status(204).send();
});

async function normalizeAutomationAdapterKey(raw: unknown) {
  if (raw == null) return null;
  if (typeof raw !== "string") {
    throw new ProjectAutomationAdapterError("自动化 Adapter key 必须是字符串");
  }

  const key = raw.trim();
  if (!key) return null;

  await resolveProjectAutomationAdapter(key);
  return key;
}

function sendProjectWriteError(res: Response, error: unknown) {
  if (error instanceof ProjectAutomationAdapterError || error instanceof RepositorySourceError) {
    res.status(400).json({ message: error.message });
    return;
  }

  if (isErrorWithCode(error) && error.code === "P2002") {
    res.status(400).json({ message: "项目名称或变量名已存在" });
    return;
  }

  console.error("[project] 保存项目失败", {
    name: error instanceof Error ? error.name : "UnknownError",
    code: isErrorWithCode(error) ? error.code : null,
    message: error instanceof Error ? error.message : "未知错误",
  });
  res.status(500).json({ message: "保存项目失败" });
}

function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string";
}
