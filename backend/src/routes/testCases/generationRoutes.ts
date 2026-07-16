import { Router } from "express";
import { prisma } from "../../infra/prisma.js";
import { startCaseGeneration } from "../../services/caseGenerationJobService.js";

export const testCaseGenerationRoutes = Router();

testCaseGenerationRoutes.get("/generations", async (req, res) => {
  const projectId = Number(req.query.projectId);
  if (!Number.isInteger(projectId)) {
    res.status(400).json({ message: "projectId 必填" });
    return;
  }

  const generations = await prisma.testCaseGeneration.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      projectId: true,
      status: true,
      hint: true,
      failureReason: true,
      createdAt: true,
      finishedAt: true,
      _count: { select: { candidates: true } },
    },
  });

  res.json({
    generations: generations.map(({ _count, ...generation }) => ({
      ...generation,
      candidateCount: _count.candidates,
    })),
  });
});

testCaseGenerationRoutes.get("/generations/:id", async (req, res) => {
  const id = Number(req.params.id);
  const generation = await prisma.testCaseGeneration.findUnique({
    where: { id },
    include: { _count: { select: { candidates: true } } },
  });
  if (!generation) {
    res.status(404).json({ message: "生成记录不存在" });
    return;
  }
  const { _count, ...detail } = generation;
  res.json({ ...detail, candidateCount: _count.candidates });
});

testCaseGenerationRoutes.post("/generate", async (req, res) => {
  const projectId = Number(req.body.projectId);
  if (!Number.isInteger(projectId)) {
    res.status(400).json({ message: "projectId 必填" });
    return;
  }
  const hint = typeof req.body.hint === "string" ? req.body.hint : undefined;
  try {
    console.log(`[testCases] 生成用例请求 projectId=${projectId} hint=${hint ? "有" : "无"}`);
    const generation = await startCaseGeneration(projectId, hint);
    res.status(202).json(generation);
  } catch (error) {
    console.error("[testCases] 生成用例失败", error instanceof Error ? error.message : error);
    res.status(400).json({ message: error instanceof Error ? error.message : "生成用例失败" });
  }
});
