import { Router } from "express";
import { prisma } from "../prisma.js";

export const projectRouter = Router();

const defaultProject = {
  name: "默认项目",
  baseUrl: "http://localhost:5173",
};

projectRouter.get("/", async (_req, res) => {
  const project =
    (await prisma.project.findFirst({ orderBy: { id: "asc" } })) ??
    (await prisma.project.create({ data: defaultProject }));

  res.json(project);
});

projectRouter.put("/", async (req, res) => {
  const { name, baseUrl } = req.body;

  if (!name || !baseUrl) {
    res.status(400).json({ message: "项目名称和 baseUrl 必填" });
    return;
  }

  const existing = await prisma.project.findFirst({ orderBy: { id: "asc" } });
  const project = existing
    ? await prisma.project.update({
        where: { id: existing.id },
        data: { name, baseUrl },
      })
    : await prisma.project.create({ data: { name, baseUrl } });

  res.json(project);
});

