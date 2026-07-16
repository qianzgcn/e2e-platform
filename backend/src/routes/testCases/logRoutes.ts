import { Router } from "express";
import { prisma } from "../../infra/prisma.js";
import { getRunArtifacts } from "../../utils/artifactService.js";

export const testCaseLogRoutes = Router();

testCaseLogRoutes.get("/:id/logs", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const where = { testCaseId: req.params.id };
  const [total, logs] = await Promise.all([
    prisma.runLog.count({ where }),
    prisma.runLog.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        testCaseId: true,
        kind: true,
        status: true,
        sourceRunLogId: true,
        startedAt: true,
        finishedAt: true,
        repairCandidate: { select: { id: true, status: true } },
      },
    }),
  ]);
  res.json({ logs, total, page, pageSize });
});

testCaseLogRoutes.get("/:id/logs/:logId", async (req, res) => {
  const logId = Number(req.params.logId);
  if (!Number.isInteger(logId)) {
    res.status(400).json({ message: "日志 ID 无效" });
    return;
  }
  const runLog = await prisma.runLog.findFirst({
    where: { id: logId, testCaseId: req.params.id },
    include: {
      repairCandidate: {
        select: {
          id: true,
          status: true,
          naturalLanguage: true,
          sourceNaturalLanguage: true,
          repairProblem: true,
          repairSuggestion: true,
        },
      },
    },
  });
  if (!runLog) {
    res.status(404).json({ message: "用例日志不存在" });
    return;
  }
  res.json({ runLog, ...(await getRunArtifacts(req.params.id, runLog.id)) });
});

testCaseLogRoutes.get("/:id/latest-run", async (req, res) => {
  const id = req.params.id;
  const runLog = await prisma.runLog.findFirst({
    where: { testCaseId: id },
    orderBy: { startedAt: "desc" },
  });
  const artifacts = runLog ? await getRunArtifacts(id, runLog.id) : { artifacts: [] };

  res.json({
    runLog,
    ...artifacts,
  });
});
