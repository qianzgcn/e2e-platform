import { ReloadOutlined, VerticalAlignBottomOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Descriptions,
  Empty,
  Modal,
  Pagination,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchTestCaseLogDetail, fetchTestCaseLogs } from "../api/testCases";
import { toBackendUrl } from "../api/url";
import type { RunLog, RunLogStatus, RunLogSummary, TestCaseLogDetail } from "../types";
import { formatDateTime } from "../utils/date";
import { StatusTag } from "./StatusTag";

const ACTIVE_STATUSES: RunLogStatus[] = ["queued", "generating", "running"];
const PAGE_SIZE = 20;

export type RunLogTarget = {
  id: string;
  title: string;
  groupName?: string | null;
};

type RunLogModalProps = {
  target: RunLogTarget | null;
  focusLogId?: number | null;
  onClose: () => void;
  onStatusChange?: () => void;
};

export function RunLogModal({ target, focusLogId, onClose, onStatusChange }: RunLogModalProps) {
  const navigate = useNavigate();
  const [history, setHistory] = useState<RunLogSummary[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TestCaseLogDetail | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const requestIdRef = useRef(0);
  const [messageApi, contextHolder] = message.useMessage();

  const loadHistory = useCallback(async (testCaseId: string, page: number, preferredLogId?: number | null) => {
    setHistoryLoading(true);
    try {
      const result = await fetchTestCaseLogs(testCaseId, page, PAGE_SIZE);
      setHistory(result.logs);
      setHistoryTotal(result.total);
      setHistoryPage(result.page);
      setSelectedLogId((current) => {
        if (preferredLogId && result.logs.some((item) => item.id === preferredLogId)) return preferredLogId;
        if (current && result.logs.some((item) => item.id === current)) return current;
        return result.logs[0]?.id ?? null;
      });
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载日志历史失败");
    } finally {
      setHistoryLoading(false);
    }
  }, [messageApi]);

  const loadDetail = useCallback(async (testCaseId: string, logId: number, showLoading = true) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (showLoading) setDetailLoading(true);
    try {
      const nextDetail = await fetchTestCaseLogDetail(testCaseId, logId);
      if (requestId === requestIdRef.current) setDetail(nextDetail);
      return nextDetail;
    } catch (error) {
      if (requestId === requestIdRef.current) {
        messageApi.error(error instanceof Error ? error.message : "加载日志详情失败");
      }
      return null;
    } finally {
      if (showLoading && requestId === requestIdRef.current) setDetailLoading(false);
    }
  }, [messageApi]);

  useEffect(() => {
    if (!target) {
      requestIdRef.current += 1;
      setHistory([]);
      setDetail(null);
      setSelectedLogId(null);
      setHistoryPage(1);
      setActiveTab("overview");
      return;
    }
    setDetail(null);
    setSelectedLogId(null);
    void loadHistory(target.id, 1, focusLogId);
  }, [focusLogId, loadHistory, target]);

  useEffect(() => {
    if (!target || selectedLogId == null) return;
    setDetail(null);
    void loadDetail(target.id, selectedLogId).then((nextDetail) => {
      if (nextDetail && ACTIVE_STATUSES.includes(nextDetail.runLog.status)) setActiveTab("process");
    });
  }, [loadDetail, selectedLogId, target]);

  const detailStatus = detail?.runLog.status;

  useEffect(() => {
    if (!target || selectedLogId == null || !detailStatus || !ACTIVE_STATUSES.includes(detailStatus)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const nextDetail = await loadDetail(target.id, selectedLogId, false);
      if (cancelled || !nextDetail) return;
      if (ACTIVE_STATUSES.includes(nextDetail.runLog.status)) {
        timer = setTimeout(poll, 1500);
      } else {
        await loadHistory(target.id, historyPage, selectedLogId);
        onStatusChange?.();
      }
    };
    timer = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [detailStatus, historyPage, loadDetail, loadHistory, onStatusChange, selectedLogId, target]);

  function handleClose() {
    requestIdRef.current += 1;
    onClose();
  }

  const candidate = detail?.runLog.repairCandidate;
  const timing = detail ? getRunTiming(detail.runLog) : null;

  return (
    <>
      {contextHolder}
      <Modal
        title="用例日志"
        open={Boolean(target)}
        onCancel={handleClose}
        footer={null}
        width={1240}
      >
        {target ? (
          <div className="grid min-h-[620px] grid-cols-[300px_minmax(0,1fr)] gap-4">
            <div className="border-r border-gray-200 pr-4">
              <div className="mb-3 flex items-center justify-between">
                <Typography.Text strong>历史记录</Typography.Text>
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={historyLoading}
                  onClick={() => void loadHistory(target.id, historyPage, selectedLogId)}
                />
              </div>
              <Spin spinning={historyLoading}>
                {history.length ? (
                  <div className="space-y-1">
                    {history.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        aria-pressed={selectedLogId === item.id}
                        className={`w-full border-0 bg-transparent px-2 py-3 text-left ${selectedLogId === item.id ? "rounded bg-blue-50" : ""}`}
                        onClick={() => setSelectedLogId(item.id)}
                      >
                    <div className="w-full">
                      <div className="flex items-center justify-between gap-2">
                        <Tag color={item.kind === "repair" ? "purple" : "blue"}>
                          {item.kind === "repair" ? "AI 修复" : "用例运行"}
                        </Tag>
                        <StatusTag status={item.status} kind={item.kind} />
                      </div>
                      <Typography.Text className="mt-1 block text-xs" type="secondary">
                        #{item.id} · {formatDateTime(item.startedAt)}
                      </Typography.Text>
                      <Typography.Text className="mt-1 block text-xs" type="secondary">
                        {formatRunTimingSummary(item)}
                      </Typography.Text>
                      {item.repairCandidate ? (
                        <Tag className="mt-1" color={candidateStatusColor(item.repairCandidate.status)}>
                          {candidateStatusText(item.repairCandidate.status)}
                        </Tag>
                      ) : null}
                    </div>
                      </button>
                    ))}
                  </div>
                ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无日志" />}
              </Spin>
              {historyTotal > PAGE_SIZE ? (
                <Pagination
                  className="mt-3"
                  simple
                  current={historyPage}
                  pageSize={PAGE_SIZE}
                  total={historyTotal}
                  onChange={(page) => target && void loadHistory(target.id, page)}
                />
              ) : null}
            </div>

            <Spin spinning={detailLoading}>
              {detail ? (
                <Tabs
                  activeKey={activeTab}
                  onChange={setActiveTab}
                  items={[
                    {
                      key: "overview",
                      label: "概览",
                      children: (
                        <Space orientation="vertical" size="middle" className="w-full">
                          <Descriptions column={1} size="small">
                            <Descriptions.Item label="用例名称">{target.title}</Descriptions.Item>
                            <Descriptions.Item label="分组">{target.groupName || "暂无"}</Descriptions.Item>
                            <Descriptions.Item label="记录类型">
                              {detail.runLog.kind === "repair" ? "AI 修复" : "用例运行"}
                            </Descriptions.Item>
                            <Descriptions.Item label="状态">
                              <StatusTag status={detail.runLog.status} kind={detail.runLog.kind} />
                            </Descriptions.Item>
                            <Descriptions.Item label="开始时间">{formatDateTime(detail.runLog.startedAt)}</Descriptions.Item>
                            <Descriptions.Item label="结束时间">{formatDateTime(detail.runLog.finishedAt)}</Descriptions.Item>
                            {timing ? (
                              <>
                                <Descriptions.Item label="总耗时">{timing.total}</Descriptions.Item>
                                <Descriptions.Item label="排队耗时">{timing.queued}</Descriptions.Item>
                                <Descriptions.Item label={timing.generationLabel}>{timing.generation}</Descriptions.Item>
                                <Descriptions.Item label={timing.executionLabel}>{timing.execution}</Descriptions.Item>
                              </>
                            ) : null}
                            {detail.runLog.sourceRunLogId ? (
                              <Descriptions.Item label="失败来源">运行记录 #{detail.runLog.sourceRunLogId}</Descriptions.Item>
                            ) : null}
                          </Descriptions>
                          {detail.runLog.failureReason ? (
                            <Alert type="error" showIcon title="失败原因" description={detail.runLog.failureReason} />
                          ) : null}
                          {candidate ? (
                            <Alert
                              type={candidate.status === "pending" ? "warning" : "success"}
                              showIcon
                              title={`自然语言修复候选：${candidateStatusText(candidate.status)}`}
                              description={candidate.repairSuggestion || candidate.repairProblem}
                              action={candidate.status === "pending" ? (
                                <Button size="small" onClick={() => navigate(`/generate-cases?candidateId=${candidate.id}`)}>
                                  前往审核
                                </Button>
                              ) : undefined}
                            />
                          ) : null}
                        </Space>
                      ),
                    },
                    {
                      key: "process",
                      label: "过程日志",
                      children: <FollowLogBlock key={detail.runLog.id} value={detail.runLog.logs} />,
                    },
                    {
                      key: "output",
                      label: "原始输出",
                      children: (
                        <Space orientation="vertical" size="middle" className="w-full">
                          <LogBlock title="stdout" value={detail.runLog.stdout} />
                          <LogBlock title="stderr" value={detail.runLog.stderr} />
                        </Space>
                      ),
                    },
                    {
                      key: "report",
                      label: "测试报告",
                      children: detail.reportUrl ? (
                        <iframe
                          title="Playwright HTML 报告"
                          src={toBackendUrl(detail.reportUrl)}
                          className="h-[540px] w-full rounded border border-gray-200"
                        />
                      ) : <Empty description="暂无测试报告" />,
                    },
                  ]}
                />
              ) : <Empty description="请选择一条日志" />}
            </Spin>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function FollowLogBlock({ value }: { value?: string | null }) {
  const containerRef = useRef<HTMLPreElement>(null);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    if (!following || !containerRef.current) return;
    requestAnimationFrame(() => {
      if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
    });
  }, [following, value]);

  function scrollToLatest() {
    setFollowing(true);
    requestAnimationFrame(() => {
      if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
    });
  }

  return (
    <div className="relative">
      <pre
        ref={containerRef}
        className="h-[520px] overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-4 text-xs text-slate-100"
        aria-live="polite"
        onScroll={(event) => {
          const element = event.currentTarget;
          setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 48);
        }}
      >
        {value || "暂无过程日志"}
      </pre>
      {!following ? (
        <Button className="!absolute bottom-4 right-4" icon={<VerticalAlignBottomOutlined />} onClick={scrollToLatest}>
          回到最新
        </Button>
      ) : null}
    </div>
  );
}

function LogBlock({ title, value }: { title: string; value?: string | null }) {
  return (
    <div className="w-full">
      <Typography.Text strong>{title}</Typography.Text>
      <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-3 text-xs text-slate-100">
        {value || "暂无输出"}
      </pre>
    </div>
  );
}

function candidateStatusText(status: "pending" | "imported" | "rejected") {
  return { pending: "待审核", imported: "已采纳", rejected: "已驳回" }[status];
}

function candidateStatusColor(status: "pending" | "imported" | "rejected") {
  return { pending: "warning", imported: "success", rejected: "default" }[status];
}

type RunTimingSource = Pick<
  RunLog,
  | "kind"
  | "status"
  | "startedAt"
  | "finishedAt"
  | "generationStartedAt"
  | "executionStartedAt"
>;

function getRunTiming(runLog: RunTimingSource) {
  const firstStageStartedAt = runLog.generationStartedAt ?? runLog.executionStartedAt;
  const generationFinishedAt = runLog.executionStartedAt ?? runLog.finishedAt;
  const isRepair = runLog.kind === "repair";

  return {
    total: formatDuration(runLog.startedAt, runLog.finishedAt),
    queued: firstStageStartedAt
      ? formatDuration(runLog.startedAt, firstStageStartedAt)
      : runLog.status === "queued"
        ? formatDuration(runLog.startedAt, null)
        : "暂无阶段记录",
    generationLabel: isRepair ? "AI 修复耗时" : "脚本生成耗时",
    generation: runLog.generationStartedAt
      ? formatDuration(runLog.generationStartedAt, generationFinishedAt)
      : runLog.executionStartedAt && !isRepair
        ? "复用已有脚本"
        : "未进入该阶段",
    executionLabel: isRepair ? "修复验证耗时" : "用例执行耗时",
    execution: runLog.executionStartedAt
      ? formatDuration(runLog.executionStartedAt, runLog.finishedAt)
      : "未进入该阶段",
  };
}

function formatRunTimingSummary(runLog: RunTimingSource) {
  const timing = getRunTiming(runLog);
  const stages = [`总计 ${timing.total}`];
  if (runLog.generationStartedAt) {
    stages.push(`${runLog.kind === "repair" ? "AI 修复" : "生成"} ${timing.generation}`);
  }
  if (runLog.executionStartedAt) {
    stages.push(`${runLog.kind === "repair" ? "验证" : "执行"} ${timing.execution}`);
  }
  return stages.join(" · ");
}

function formatDuration(start: string, end?: string | null) {
  const startedAt = Date.parse(start);
  const finishedAt = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) {
    return "—";
  }

  const durationMs = Math.max(0, finishedAt - startedAt);
  if (durationMs < 1000) {
    return `${durationMs} 毫秒`;
  }

  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)} 秒`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} 分 ${seconds} 秒`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} 小时 ${minutes} 分 ${seconds} 秒`;
}
