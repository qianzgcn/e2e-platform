import { Router } from "express";
import { prisma } from "../prisma.js";

export const dashboardRouter = Router();

type FailedTestCaseRow = {
  id: string;
  title: string;
  group: {
    name: string;
  };
  lastFailureReason: string | null;
};

dashboardRouter.get("/", async (_req, res) => {
  const [totalCases, successCases, recentFailedCases] = await Promise.all([
    prisma.testCase.count(),
    prisma.testCase.count({ where: { status: "success" } }),
    prisma.testCase.findMany({
      where: { status: "failed" },
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
        lastFailureReason: true,
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
      failureReason: item.lastFailureReason ?? "",
    })),
  });
});
