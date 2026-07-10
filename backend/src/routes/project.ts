import { Router } from "express";
import { prisma } from "../infra/prisma.js";
import { testRepoConnectivity } from "../infra/repoService.js";

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
  const { name, baseUrl, repoUrl, promptHint } = req.body;
  const variables = normalizeVariables(req.body.variables);

  if (!name || !baseUrl) {
    res.status(400).json({ message: "项目名称和 baseUrl 必填" });
    return;
  }

  try {
    const project = await prisma.project.create({
      data: { name, baseUrl, repoUrl, promptHint: promptHint || null, variables: { create: variables } },
      include: projectInclude,
    });
    res.status(201).json(project);
  } catch {
    res.status(400).json({ message: "项目名已存在" });
  }
});

// 测试代码仓库 URL 是否可访问（git ls-remote，不 clone）。
projectRouter.post("/test-repo", async (req, res) => {
  const repoUrl = typeof req.body.repoUrl === "string" ? req.body.repoUrl.trim() : "";
  if (!repoUrl) {
    res.status(400).json({ message: "请输入代码仓库 URL" });
    return;
  }
  try {
    await testRepoConnectivity(repoUrl);
    res.json({ ok: true, message: "仓库连通正常" });
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
  const { name, baseUrl, repoUrl, promptHint } = req.body;
  const variables = normalizeVariables(req.body.variables);

  if (!name || !baseUrl) {
    res.status(400).json({ message: "项目名称和 baseUrl 必填" });
    return;
  }

  try {
    const project = await prisma.project.update({
      where: { id },
      data: { name, baseUrl, repoUrl, promptHint: promptHint || null, variables: { deleteMany: {}, create: variables } },
      include: projectInclude,
    });
    res.json(project);
  } catch {
    res.status(400).json({ message: "项目名已存在" });
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
