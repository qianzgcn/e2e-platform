import { Router } from "express";
import { prisma } from "../infra/prisma.js";

export const testCaseGroupsRouter = Router();

testCaseGroupsRouter.get("/", async (req, res) => {
  const projectId = Number(req.query.projectId);
  const groups = await prisma.testCaseGroup.findMany({
    where: Number.isInteger(projectId) ? { projectId } : undefined,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      projectId: true,
      name: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  res.json(groups);
});

testCaseGroupsRouter.post("/", async (req, res) => {
  const { name, projectId } = req.body;

  if (!name || !Number.isInteger(projectId)) {
    res.status(400).json({ message: "分组名称和 projectId 必填" });
    return;
  }

  const group = await prisma.testCaseGroup.create({
    data: { name, projectId },
  });

  res.status(201).json(group);
});

testCaseGroupsRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const testCaseCount = await prisma.testCase.count({ where: { groupId: id } });

  if (testCaseCount > 0) {
    res.status(400).json({ message: "该分组下已有用例，不能删除" });
    return;
  }

  await prisma.testCaseGroup.delete({ where: { id } });
  res.status(204).send();
});
