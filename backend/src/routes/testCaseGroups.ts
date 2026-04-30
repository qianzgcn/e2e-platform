import { Router } from "express";
import { prisma } from "../prisma.js";

export const testCaseGroupsRouter = Router();

testCaseGroupsRouter.get("/", async (_req, res) => {
  const groups = await prisma.testCaseGroup.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  res.json(groups);
});

testCaseGroupsRouter.post("/", async (req, res) => {
  const { name } = req.body;

  if (!name) {
    res.status(400).json({ message: "分组名称必填" });
    return;
  }

  const group = await prisma.testCaseGroup.create({
    data: { name },
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
