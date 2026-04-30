import cors from "cors";
import express from "express";
import path from "node:path";
import { dashboardRouter } from "./routes/dashboard.js";
import { projectRouter } from "./routes/project.js";
import { runLogsRouter } from "./routes/runLogs.js";
import { testCaseGroupsRouter } from "./routes/testCaseGroups.js";
import { testCasesRouter } from "./routes/testCases.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/test-results", express.static(path.resolve(process.cwd(), "test-results")));

app.use("/api/dashboard", dashboardRouter);
app.use("/api/project", projectRouter);
app.use("/api/run-logs", runLogsRouter);
app.use("/api/test-case-groups", testCaseGroupsRouter);
app.use("/api/test-cases", testCasesRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

const port = 3001;

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});
