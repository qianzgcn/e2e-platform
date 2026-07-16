import { PlusOutlined } from "@ant-design/icons";
import { Alert, Button, Modal, Typography, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createTestCaseGroup, fetchTestCaseGroups } from "../api/testCaseGroups";
import {
  createTestCase,
  deleteTestCase,
  deleteTestCases,
  exportTestCaseRows,
  fetchTestCase,
  fetchTestCases,
  importTestCases,
  runAllTestCases,
  runTestCase,
  runTestCases,
  repairTestCase,
  stopTestCase,
  updateTestCase,
} from "../api/testCases";
import { RunLogModal } from "../components/RunLogModal";
import { TestCaseModal } from "../components/TestCaseModal";
import { TestCaseTable } from "../components/test-cases/TestCaseTable";
import { TestCaseToolbar } from "../components/test-cases/TestCaseToolbar";
import { useProject } from "../projectContextState";
import type {
  RunRequestResult,
  StopRunResult,
  TestCaseDetail,
  TestCaseGroup,
  TestCaseListItem,
  TestCasePayload,
} from "../types";
import { readTestCaseWorkbook, writeTestCaseWorkbook } from "../utils/testCaseWorkbook";
import { isBusyStatus } from "../utils/testCaseStatus";

const ACTIVE_CASE_POLL_INTERVAL_MS = 5000;

export function TestCasePage() {
  const { currentProjectId } = useProject();
  const [items, setItems] = useState<TestCaseListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [groups, setGroups] = useState<TestCaseGroup[]>([]);
  const [titleKeyword, setTitleKeyword] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCase, setEditingCase] = useState<TestCaseDetail | null>(null);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [runLogItem, setRunLogItem] = useState<TestCaseListItem | null>(null);
  const [focusRunLogId, setFocusRunLogId] = useState<number | null>(null);
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();
  const [modal, modalContextHolder] = Modal.useModal();

  const hasBusyCase = items.some((item) => isBusyStatus(item.status));

  const loadTestCases = useCallback(async (showLoading = true) => {
    if (currentProjectId == null) {
      setItems([]);
      return;
    }
    if (showLoading) {
      setLoading(true);
    }

    try {
      const testCases = await fetchTestCases(currentProjectId, titleKeyword);
      setItems(testCases);
      setSelectedRowKeys((current) => current.filter((id) => testCases.some((item) => item.id === id)));
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载用例失败");
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [currentProjectId, messageApi, titleKeyword]);

  const loadGroups = useCallback(async () => {
    if (currentProjectId == null) {
      setGroups([]);
      return;
    }
    try {
      setGroups(await fetchTestCaseGroups(currentProjectId));
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载分组失败");
    }
  }, [currentProjectId, messageApi]);

  useEffect(() => {
    void loadTestCases();
  }, [loadTestCases]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    if (!hasBusyCase) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadTestCases(false);
    }, ACTIVE_CASE_POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [hasBusyCase, loadTestCases]);

  async function openCreateModal() {
    setEditingCase(null);
    setModalOpen(true);
  }

  async function openEditModal(id: string) {
    setLoading(true);
    try {
      setEditingCase(await fetchTestCase(id));
      setModalOpen(true);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载用例详情失败");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(data: TestCasePayload) {
    setSaving(true);
    try {
      if (editingCase) {
        await updateTestCase(editingCase.id, data);
      } else {
        await createTestCase(data);
      }
      setModalOpen(false);
      await loadTestCases();
      messageApi.success("用例已保存");
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "保存用例失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateGroup(name: string) {
    if (currentProjectId == null) {
      throw new Error("请先选择项目");
    }
    try {
      const group = await createTestCaseGroup(currentProjectId, name);
      setGroups((current) => [...current, group]);
      messageApi.success("分组已创建");
      return group;
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "创建分组失败");
      throw error;
    }
  }

  async function handleRun(item: TestCaseListItem) {
    try {
      const result = await runTestCase(item.id);
      showRunRequestMessage(result, "single");
      await loadTestCases();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "运行失败");
    }
  }

  function handleRepair(item: TestCaseListItem) {
    modal.confirm({
      title: "AI 修复失败用例",
      content: item.scriptNeedsGeneration
        ? "当前用例在脚本生成阶段失败。AI 将诊断用例内容和失败原因；可安全修改时生成待审核的自然语言修复候选，否则给出不可修复结论。"
        : "AI 将分析失败日志、录屏、业务代码和真实页面。只有脚本修复验证通过后才会替换当前脚本；用例内容问题会生成待审核候选。",
      okText: "开始修复",
      cancelText: "取消",
      async onOk() {
        try {
          const { repairLogId } = await repairTestCase(item.id);
          setFocusRunLogId(repairLogId);
          setRunLogItem(item);
          await loadTestCases(false);
          messageApi.success("AI 修复任务已开始");
        } catch (error) {
          messageApi.error(error instanceof Error ? error.message : "AI 修复提交失败");
          throw error;
        }
      },
    });
  }

  async function handleDelete(item: TestCaseListItem) {
    modal.confirm({
      title: "删除用例",
      content: `确认删除「${item.title}」吗？`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        try {
          await deleteTestCase(item.id);
          await loadTestCases();
          messageApi.success("用例已删除");
        } catch (error) {
          messageApi.error(error instanceof Error ? error.message : "删除用例失败");
          throw error;
        }
      },
    });
  }

  async function handleBatchRun() {
    if (!selectedRowKeys.length) {
      return;
    }

    try {
      const result = await runTestCases(selectedRowKeys);
      showRunRequestMessage(result, "batch");
      setSelectedRowKeys([]);
      await loadTestCases();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "批量运行失败");
    }
  }

  async function handleExportSelected() {
    if (!selectedRowKeys.length) {
      return;
    }

    setExporting(true);
    try {
      const { rows } = await exportTestCaseRows(selectedRowKeys);
      if (!rows.length) {
        messageApi.warning("没有可导出的用例");
        return;
      }

      await writeTestCaseWorkbook(rows);
      messageApi.success(`已导出 ${rows.length} 条用例`);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "导出用例失败");
    } finally {
      setExporting(false);
    }
  }

  async function handleImportFile(file: File) {
    if (currentProjectId == null) {
      return;
    }

    setImporting(true);
    try {
      const rows = await readTestCaseWorkbook(file);
      if (!rows.length) {
        messageApi.warning("Excel 中没有可导入的用例");
        return;
      }

      const result = await importTestCases(currentProjectId, rows);
      messageApi.success(`已导入 ${result.createdCount} 条，跳过 ${result.skippedCount} 条`);
      await Promise.all([loadTestCases(), loadGroups()]);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "导入用例失败");
    } finally {
      setImporting(false);
    }
  }

  async function handleRunAll() {
    if (currentProjectId == null) {
      return;
    }
    setRunningAll(true);
    try {
      const result = await runAllTestCases(currentProjectId);
      showRunRequestMessage(result, "all");
      await loadTestCases();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "全量运行失败");
    } finally {
      setRunningAll(false);
    }
  }

  async function handleStop(item: TestCaseListItem) {
    const stop = async () => {
      try {
        const result = await stopTestCase(item.id);
        showStopRequestMessage(result);
        await loadTestCases();
      } catch (error) {
        messageApi.error(error instanceof Error ? error.message : "停止用例失败");
      }
    };

    if (item.status === "generating") {
      modal.confirm({
        title: "停止用例生成",
        content: "确认停止该用例的生成吗？",
        okText: "停止",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: stop,
      });
      return;
    }

    await stop();
  }

  function showStopRequestMessage(result: StopRunResult) {
    if (!result.stopped) {
      messageApi.warning("该用例已结束");
      return;
    }

    if (result.affectedTestCaseIds.length > 1) {
      messageApi.success(`已停止，共 ${result.affectedTestCaseIds.length} 条用例`);
      return;
    }

    messageApi.success("已停止用例");
  }

  function showRunRequestMessage(result: RunRequestResult, mode: "single" | "batch" | "all") {
    const queuedCount = result.runIds.length;
    const skippedCount = result.skippedCases.length;

    if (mode === "single") {
      if (queuedCount) {
        messageApi.success("已加入运行队列");
      } else {
        messageApi.warning("该用例正在运行中，已跳过");
      }
      return;
    }

    if (mode === "all") {
      if (queuedCount && skippedCount) {
        messageApi.success(`已加入 ${queuedCount} 条，跳过 ${skippedCount} 条运行中的用例`);
        return;
      }

      if (queuedCount) {
        messageApi.success(`已加入 ${queuedCount} 条用例到运行队列`);
        return;
      }

      messageApi.warning(skippedCount ? "所有用例均在运行中，已跳过" : "暂无用例可运行");
      return;
    }

    if (queuedCount && skippedCount) {
      messageApi.success(`已加入 ${queuedCount} 条，跳过 ${skippedCount} 条运行中的用例`);
      return;
    }

    if (queuedCount) {
      messageApi.success("已加入运行队列");
      return;
    }

    messageApi.warning("选中的用例均在运行中，已跳过");
  }

  async function handleBatchDelete() {
    if (!selectedRowKeys.length) {
      return;
    }

    modal.confirm({
      title: "批量删除用例",
      content: `确认删除选中的 ${selectedRowKeys.length} 条用例吗？`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        try {
          await deleteTestCases(selectedRowKeys);
          setSelectedRowKeys([]);
          await loadTestCases();
          messageApi.success("用例已删除");
        } catch (error) {
          messageApi.error(error instanceof Error ? error.message : "批量删除失败");
          throw error;
        }
      },
    });
  }

  function showRunLog(item: TestCaseListItem) {
    setFocusRunLogId(null);
    setRunLogItem(item);
  }

  return (
    <div className="space-y-5">
      {contextHolder}
      {modalContextHolder}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Typography.Title level={3} className="!mb-1">
            用例管理
          </Typography.Title>
          <Typography.Text type="secondary">维护自然语言用例并执行 Playwright 脚本</Typography.Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} disabled={currentProjectId == null} onClick={openCreateModal}>
          新增用例
        </Button>
      </div>

      {currentProjectId == null ? (
        <Alert type="info" showIcon message="请先在顶部选择一个项目" />
      ) : (
        <div className="content-panel p-4">
          <TestCaseToolbar
            loading={loading}
            runningAll={runningAll}
            exporting={exporting}
            importing={importing}
            selectedCount={selectedRowKeys.length}
            onSearch={setTitleKeyword}
            onRefresh={() => void loadTestCases()}
            onRunAll={() => void handleRunAll()}
            onGenerate={() => navigate("/generate-cases")}
            onBatchRun={() => void handleBatchRun()}
            onBatchDelete={() => void handleBatchDelete()}
            onExport={() => void handleExportSelected()}
            onImportFile={handleImportFile}
          />
          <TestCaseTable
            items={items}
            loading={loading}
            selectedRowKeys={selectedRowKeys}
            onSelectionChange={setSelectedRowKeys}
            onEdit={(id) => void openEditModal(id)}
            onShowLog={showRunLog}
            onReviewCandidate={(candidateId) => navigate(`/generate-cases?candidateId=${candidateId}`)}
            onStop={(item) => void handleStop(item)}
            onRun={(item) => void handleRun(item)}
            onRepair={handleRepair}
            onDelete={(item) => void handleDelete(item)}
          />
        </div>
      )}

      <TestCaseModal
        open={modalOpen}
        loading={saving}
        initialValue={editingCase}
        groups={groups}
        onCancel={() => setModalOpen(false)}
        onSubmit={handleSubmit}
        onCreateGroup={handleCreateGroup}
      />

      <RunLogModal
        target={runLogItem}
        focusLogId={focusRunLogId}
        onClose={() => {
          setRunLogItem(null);
          setFocusRunLogId(null);
        }}
        onStatusChange={() => void loadTestCases(false)}
      />
    </div>
  );
}
