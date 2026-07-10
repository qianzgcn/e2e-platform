import { Router } from "express";
import { prisma } from "../infra/prisma.js";

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
  const { name, baseUrl } = req.body;
  const variables = normalizeVariables(req.body.variables);

  if (!name || !baseUrl) {
    res.status(400).json({ message: "项目名称和 baseUrl 必填" });
    return;
  }

  try {
    const project = await prisma.project.create({
      data: { name, baseUrl, variables: { create: variables } },
      include: projectInclude,
    });
    res.status(201).json(project);
  } catch {
    res.status(400).json({ message: "项目名已存在" });
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
  const { name, baseUrl } = req.body;
  const variables = normalizeVariables(req.body.variables);

  if (!name || !baseUrl) {
    res.status(400).json({ message: "项目名称和 baseUrl 必填" });
    return;
  }

  try {
    const project = await prisma.project.update({
      where: { id },
      data: { name, baseUrl, variables: { deleteMany: {}, create: variables } },
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
