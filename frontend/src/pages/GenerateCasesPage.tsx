import { Alert, Button, Card, Input, Modal, Space, Table, Tag, Typography, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  applyRepairCandidate,
  fetchCandidates,
  fetchGenerationHistory,
  fetchGenerationLogs,
  generateTestCaseCandidates,
  importCandidates,
  rejectRepairCandidate,
} from "../api/testCases";
import { useProject } from "../projectContextState";
import type {
  TestCaseCandidate,
  TestCaseGeneration,
  TestCaseGenerationStatus,
  TestCaseGenerationSummary,
} from "../types";
import { formatDateTime } from "../utils/date";

const GENERATION_STATUS: Record<TestCaseGenerationStatus, { color: string; text: string }> = {
  running: { color: "processing", text: "生成中" },
  success: { color: "success", text: "成功" },
  failed: { color: "error", text: "失败" },
};

export function GenerateCasesPage() {
  const { currentProjectId } = useProject();
  const [candidates, setCandidates] = useState<TestCaseCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [hint, setHint] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [activeGenerationId, setActiveGenerationId] = useState<number | null>(null);
  const [activeGeneration, setActiveGeneration] = useState<TestCaseGeneration | null>(null);
  const [generationHistory, setGenerationHistory] = useState<TestCaseGenerationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedGeneration, setSelectedGeneration] = useState<TestCaseGeneration | null>(null);
  const [loadingGenerationId, setLoadingGenerationId] = useState<number | null>(null);
  const [reviewCandidate, setReviewCandidate] = useState<TestCaseCandidate | null>(null);
  const [reviewNaturalLanguage, setReviewNaturalLanguage] = useState("");
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewRejecting, setReviewRejecting] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedCandidateId = Number(searchParams.get("candidateId"));

  const loadCandidates = useCallback(async () => {
    if (currentProjectId == null) {
      setCandidates([]);
      setSelectedIds([]);
      return;
    }
    try {
      const { candidates: list } = await fetchCandidates(currentProjectId);
      setCandidates(list);
      setSelectedIds(list.filter((candidate) => candidate.kind === "generated").map((candidate) => candidate.id));
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载候选失败");
    }
  }, [currentProjectId, messageApi]);

  const loadGenerationHistory = useCallback(async (resumeRunning = false) => {
    if (currentProjectId == null) {
      setGenerationHistory([]);
      setActiveGenerationId(null);
      return;
    }

    setHistoryLoading(true);
    try {
      const { generations } = await fetchGenerationHistory(currentProjectId);
      setGenerationHistory(generations);
      if (resumeRunning) {
        setActiveGenerationId(generations.find((item) => item.status === "running")?.id ?? null);
      }
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载生成历史失败");
    } finally {
      setHistoryLoading(false);
    }
  }, [currentProjectId, messageApi]);

  useEffect(() => {
    setActiveGenerationId(null);
    setActiveGeneration(null);
    setSelectedGeneration(null);
    void Promise.all([loadCandidates(), loadGenerationHistory(true)]);
  }, [loadCandidates, loadGenerationHistory]);

  useEffect(() => {
    if (!Number.isInteger(requestedCandidateId) || reviewCandidate) return;
    const candidate = candidates.find((item) => item.id === requestedCandidateId && item.kind === "repair");
    if (!candidate) return;
    setReviewCandidate(candidate);
    setReviewNaturalLanguage(candidate.naturalLanguage);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("candidateId");
      return next;
    }, { replace: true });
  }, [candidates, requestedCandidateId, reviewCandidate, setSearchParams]);

  useEffect(() => {
    if (activeGenerationId == null || currentProjectId == null) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const detail = await fetchGenerationLogs(activeGenerationId);
        if (cancelled || detail.projectId !== currentProjectId) {
          return;
        }

        setActiveGeneration(detail);
        setGenerationHistory((current) =>
          current.map((item) => (item.id === detail.id ? toGenerationSummary(detail) : item)),
        );

        if (detail.status === "running") {
          timer = setTimeout(poll, 1500);
          return;
        }

        setActiveGenerationId(null);
        if (detail.status === "success") {
          messageApi.success(`生成完成，共 ${detail.candidateCount} 条候选用例`);
        } else {
          messageApi.error("生成失败，请查看本次日志中的失败原因");
        }
        await Promise.all([loadCandidates(), loadGenerationHistory()]);
      } catch {
        if (!cancelled) {
          timer = setTimeout(poll, 3000);
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [activeGenerationId, currentProjectId, loadCandidates, loadGenerationHistory, messageApi]);

  async function handleGenerate() {
    if (currentProjectId == null) {
      return;
    }

    setSubmitting(true);
    setActiveGeneration(null);
    try {
      const { generationId } = await generateTestCaseCandidates(currentProjectId, hint.trim() || undefined);
      setActiveGenerationId(generationId);
      messageApi.info("生成任务已开始，可在下方实时查看进度");
      await loadGenerationHistory();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "生成失败");
    } finally {
      setSubmitting(false);
    }
  }

  function updateCandidate(id: number, patch: Partial<TestCaseCandidate>) {
    setCandidates((current) => current.map((candidate) => (candidate.id === id ? { ...candidate, ...patch } : candidate)));
  }

  async function handleImport() {
    if (!selectedIds.length) {
      return;
    }
    setImporting(true);
    try {
      const selected = candidates.filter(
        (candidate) => candidate.kind === "generated" && selectedIds.includes(candidate.id),
      );
      const result = await importCandidates(selected);
      messageApi.success(`已导入 ${result.createdCount} 条，跳过 ${result.skippedCount} 条`);
      await loadCandidates();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setImporting(false);
    }
  }

  function openRepairReview(candidate: TestCaseCandidate) {
    setReviewCandidate(candidate);
    setReviewNaturalLanguage(candidate.naturalLanguage);
  }

  async function handleApplyRepairCandidate() {
    if (!reviewCandidate || !reviewNaturalLanguage.trim()) return;
    setReviewSaving(true);
    try {
      await applyRepairCandidate(reviewCandidate.id, reviewNaturalLanguage.trim());
      messageApi.success("修复候选已采纳，原用例已标记为待生成脚本");
      setReviewCandidate(null);
      await loadCandidates();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "采纳修复候选失败");
    } finally {
      setReviewSaving(false);
    }
  }

  async function handleRejectRepairCandidate() {
    if (!reviewCandidate) return;
    setReviewRejecting(true);
    try {
      await rejectRepairCandidate(reviewCandidate.id);
      messageApi.success("修复候选已驳回，原用例未修改");
      setReviewCandidate(null);
      await loadCandidates();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "驳回修复候选失败");
    } finally {
      setReviewRejecting(false);
    }
  }

  async function handleViewLogs(id: number) {
    setLoadingGenerationId(id);
    try {
      setSelectedGeneration(await fetchGenerationLogs(id));
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载日志失败");
    } finally {
      setLoadingGenerationId(null);
    }
  }

  const isGenerating = submitting || activeGenerationId != null;
  const activeStatus = activeGeneration ? GENERATION_STATUS[activeGeneration.status] : GENERATION_STATUS.running;

  return (
    <div className="space-y-4">
      {contextHolder}
      <Typography.Title level={3}>AI 生成用例</Typography.Title>
      <Card>
        <Typography.Paragraph type="secondary">AI 读取项目代码仓库生成用例候选，勾选后导入。生成约需 2-5 分钟。</Typography.Paragraph>
        <Input.TextArea
          value={hint}
          onChange={(event) => setHint(event.target.value)}
          placeholder="生成要求（可选）：如只生成登录和用户管理模块、生成 20 条、关注异常分支等"
          autoSize={{ minRows: 2, maxRows: 4 }}
        />
        <Space className="mt-4">
          <Button onClick={handleGenerate} loading={isGenerating} disabled={currentProjectId == null || isGenerating}>
            生成候选
          </Button>
          <Button type="primary" onClick={handleImport} loading={importing} disabled={!selectedIds.length}>
            导入选中（{selectedIds.length}）
          </Button>
        </Space>
      </Card>

      {activeGenerationId != null || activeGeneration ? (
        <Card
          title="本次生成进度"
          extra={<Tag color={activeStatus.color}>{activeStatus.text}</Tag>}
        >
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-4 text-sm text-slate-100" aria-live="polite">
            {activeGeneration?.logs || "正在读取生成进度..."}
          </pre>
          {activeGeneration?.failureReason ? (
            <Alert className="mt-3" type="error" showIcon title="生成失败" description={activeGeneration.failureReason} />
          ) : null}
        </Card>
      ) : null}

      <Card title={`候选用例（${candidates.length}）`}>
        <Table<TestCaseCandidate>
          rowKey="id"
          dataSource={candidates}
          pagination={false}
          scroll={{ y: 480 }}
          rowSelection={{
            selectedRowKeys: selectedIds,
            onChange: (keys) => setSelectedIds(keys.map(Number)),
            getCheckboxProps: (record) => ({ disabled: record.kind === "repair" }),
          }}
          columns={[
            {
              title: "来源",
              dataIndex: "kind",
              width: 100,
              render: (value: TestCaseCandidate["kind"]) => (
                <Tag color={value === "repair" ? "purple" : "blue"}>
                  {value === "repair" ? "AI 修复" : "AI 生成"}
                </Tag>
              ),
            },
            {
              title: "标题",
              dataIndex: "title",
              width: 160,
              render: (value: string, record) => (
                record.kind === "repair" ? value : (
                  <Input value={value} onChange={(event) => updateCandidate(record.id, { title: event.target.value })} />
                )
              ),
            },
            {
              title: "分组",
              dataIndex: "groupName",
              width: 120,
              render: (value: string, record) => (
                record.kind === "repair" ? value : (
                  <Input value={value} onChange={(event) => updateCandidate(record.id, { groupName: event.target.value })} />
                )
              ),
            },
            {
              title: "自然语言步骤",
              dataIndex: "naturalLanguage",
              render: (value: string, record) => (
                record.kind === "repair" ? (
                  <Typography.Paragraph ellipsis={{ rows: 3 }} className="!mb-0 whitespace-pre-wrap">
                    {value}
                  </Typography.Paragraph>
                ) : (
                  <Input.TextArea
                    value={value}
                    autoSize={{ minRows: 2 }}
                    onChange={(event) => updateCandidate(record.id, { naturalLanguage: event.target.value })}
                  />
                )
              ),
            },
            {
              title: "操作",
              width: 90,
              render: (_, record) => record.kind === "repair" ? (
                <Button type="link" onClick={() => openRepairReview(record)}>审核</Button>
              ) : null,
            },
          ]}
        />
      </Card>

      <Modal
        title={`审核自然语言修复候选${reviewCandidate ? ` #${reviewCandidate.id}` : ""}`}
        open={reviewCandidate !== null}
        onCancel={() => setReviewCandidate(null)}
        width={980}
        footer={[
          <Button key="reject" danger loading={reviewRejecting} onClick={() => void handleRejectRepairCandidate()}>
            驳回
          </Button>,
          <Button
            key="apply"
            type="primary"
            loading={reviewSaving}
            disabled={Boolean(reviewCandidate?.stale) || !reviewNaturalLanguage.trim()}
            onClick={() => void handleApplyRepairCandidate()}
          >
            采纳并更新原用例
          </Button>,
        ]}
      >
        {reviewCandidate ? (
          <Space orientation="vertical" size="middle" className="w-full">
            {reviewCandidate.stale ? (
              <Alert type="warning" showIcon title="候选已过期" description="原用例在候选生成后已被修改，请驳回并重新发起 AI 修复。" />
            ) : null}
            <Alert
              type="info"
              showIcon
              title="AI 修复说明"
              description={(
                <div className="space-y-1">
                  <div>问题：{reviewCandidate.repairProblem || "未提供"}</div>
                  <div>建议：{reviewCandidate.repairSuggestion || "未提供"}</div>
                </div>
              )}
            />
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Typography.Text strong>原测试步骤</Typography.Text>
                <Input.TextArea className="mt-2" value={reviewCandidate.sourceNaturalLanguage || ""} readOnly autoSize={{ minRows: 12 }} />
              </div>
              <div>
                <Typography.Text strong>建议测试步骤（可编辑）</Typography.Text>
                <Input.TextArea
                  className="mt-2"
                  value={reviewNaturalLanguage}
                  onChange={(event) => setReviewNaturalLanguage(event.target.value)}
                  autoSize={{ minRows: 12 }}
                />
              </div>
            </div>
            <Typography.Text type="secondary">采纳后旧脚本会失效，用例不会自动运行。</Typography.Text>
          </Space>
        ) : null}
      </Modal>

      <Card title="生成历史">
        <Table<TestCaseGenerationSummary>
          rowKey="id"
          loading={historyLoading}
          dataSource={generationHistory}
          pagination={{ pageSize: 8, showSizeChanger: false }}
          columns={[
            {
              title: "开始时间",
              dataIndex: "createdAt",
              width: 180,
              render: (value: string) => formatDateTime(value),
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 90,
              render: (value: TestCaseGenerationStatus) => {
                const status = GENERATION_STATUS[value];
                return <Tag color={status.color}>{status.text}</Tag>;
              },
            },
            {
              title: "生成要求",
              dataIndex: "hint",
              ellipsis: true,
              render: (value: string | null) => value || "默认要求",
            },
            {
              title: "候选数",
              dataIndex: "candidateCount",
              width: 90,
            },
            {
              title: "耗时",
              width: 100,
              render: (_, record) => formatDuration(record.createdAt, record.finishedAt, record.status),
            },
            {
              title: "操作",
              width: 90,
              render: (_, record) => (
                <Button type="link" loading={loadingGenerationId === record.id} onClick={() => handleViewLogs(record.id)}>
                  查看日志
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={`生成日志${selectedGeneration ? ` #${selectedGeneration.id}` : ""}`}
        open={selectedGeneration !== null}
        onCancel={() => setSelectedGeneration(null)}
        footer={null}
        width={760}
      >
        {selectedGeneration ? (
          <Space orientation="vertical" size="middle" className="w-full">
            <Space wrap>
              <Tag color={GENERATION_STATUS[selectedGeneration.status].color}>
                {GENERATION_STATUS[selectedGeneration.status].text}
              </Tag>
              <Typography.Text type="secondary">开始：{formatDateTime(selectedGeneration.createdAt)}</Typography.Text>
              <Typography.Text type="secondary">
                耗时：{formatDuration(selectedGeneration.createdAt, selectedGeneration.finishedAt, selectedGeneration.status)}
              </Typography.Text>
              <Typography.Text type="secondary">候选：{selectedGeneration.candidateCount} 条</Typography.Text>
            </Space>
            {selectedGeneration.hint ? <Typography.Text>生成要求：{selectedGeneration.hint}</Typography.Text> : null}
            {selectedGeneration.failureReason ? (
              <Alert type="error" showIcon title="生成失败" description={selectedGeneration.failureReason} />
            ) : null}
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-4 text-sm text-slate-100">
              {selectedGeneration.logs || "暂无日志"}
            </pre>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}

function toGenerationSummary(generation: TestCaseGeneration): TestCaseGenerationSummary {
  return {
    id: generation.id,
    projectId: generation.projectId,
    status: generation.status,
    hint: generation.hint,
    failureReason: generation.failureReason,
    candidateCount: generation.candidateCount,
    createdAt: generation.createdAt,
    finishedAt: generation.finishedAt,
  };
}

function formatDuration(
  startedAt: string,
  finishedAt: string | null,
  status: TestCaseGenerationStatus,
) {
  if (!finishedAt) {
    return status === "running" ? "进行中" : "—";
  }

  const seconds = Math.max(0, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
