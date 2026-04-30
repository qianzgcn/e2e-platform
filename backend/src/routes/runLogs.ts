import { Router } from "express";
import { prisma } from "../prisma.js";

export const runLogsRouter = Router();

runLogsRouter.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const runLog = await prisma.runLog.findUnique({ where: { id } });

  if (!runLog) {
    res.status(404).json({ message: "运行日志不存在" });
    return;
  }

  res.json(runLog);
});

