import { Router } from "express";
import { prisma } from "../prisma.js";

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

projectRouter.get("/", async (_req, res) => {
  const project = await prisma.project.findFirst({ orderBy: { id: "asc" }, include: projectInclude });

  res.json(project);
});

projectRouter.put("/", async (req, res) => {
  const { name, baseUrl } = req.body;
  const variables = ((req.body.variables ?? []) as ProjectVariableInput[]).map((variable) => ({
    name: variable.name.trim(),
    value: variable.value,
    description: variable.description?.trim() || null,
  }));

  if (!name || !baseUrl) {
    res.status(400).json({ message: "项目名称和 baseUrl 必填" });
    return;
  }

  const existing = await prisma.project.findFirst({ orderBy: { id: "asc" } });
  const project = existing
    ? await prisma.project.update({
        where: { id: existing.id },
        data: {
          name,
          baseUrl,
          variables: {
            deleteMany: {},
            create: variables,
          },
        },
        include: projectInclude,
      })
    : await prisma.project.create({
        data: {
          name,
          baseUrl,
          variables: {
            create: variables,
          },
        },
        include: projectInclude,
      });

  res.json(project);
});
