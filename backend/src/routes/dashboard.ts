import { Router } from "express";
import { prisma } from "../prisma.js";

export const dashboardRouter = Router();

type FailedTestCaseRow = {
  id: string;
  title: string;
  group: {
    name: string;
  };
  lastRunAt: Date | null;
};

dashboardRouter.get("/", async (req, res) => {
  const projectId = Number(req.query.projectId);
  const where = Number.isInteger(projectId) ? { projectId } : undefined;
  const [totalCases, successCases, recentFailedCases] = await Promise.all([
    prisma.testCase.count({ where }),
    prisma.testCase.count({ where: { ...where, status: "success" } }),
    prisma.testCase.findMany({
      where: { ...where, status: "failed" },
      orderBy: { lastRunAt: "desc" },
      take: 5,
      select: {
        id: true,
        title: true,
        group: {
          select: {
            name: true,
          },
        },
        lastRunAt: true,
      },
    }),
  ]);

  res.json({
    successRate: totalCases === 0 ? 0 : Math.round((successCases / totalCases) * 100),
    totalCases,
    recentFailedCases: recentFailedCases.map((item: FailedTestCaseRow) => ({
      id: item.id,
      title: item.title,
      groupName: item.group.name,
      lastRunAt: item.lastRunAt,
    })),
  });
});
