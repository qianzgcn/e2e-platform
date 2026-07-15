import {
  DeleteOutlined,
  ExportOutlined,
  FileTextOutlined,
  ImportOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { Alert, Button, Input, Modal, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import type { ColumnType } from "antd/es/table";
import type { ChangeEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { isBusyStatus, StatusTag } from "../components/StatusTag";
import { TestCaseModal } from "../components/TestCaseModal";
import { useProject } from "../ProjectContext";
import type {
  RunRequestResult,
  StopRunResult,
  TestCaseDetail,
  TestCaseExcelRow,
  TestCaseGroup,
  TestCaseListItem,
  TestCasePayload,
} from "../types";
import { formatDateTime } from "../utils/date";

const ACTIVE_CASE_POLL_INTERVAL_MS = 5000;
const EXCEL_COLUMNS = {
  title: "用例名称",
  groupName: "分组",
  naturalLanguage: "测试步骤",
} as const;

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
  const importInputRef = useRef<HTMLInputElement>(null);
  const [messageApi, contextHolder] = message.useMessage();
  const [modal, modalContextHolder] = Modal.useModal();

  const hasBusyCase = useMemo(() => items.some((item) => isBusyStatus(item.status)), [items]);
  const groupFilters = useMemo(() => toFilters(items.map((item) => item.groupName)), [items]);

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
      return undefined;
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
      content: "AI 将分析失败日志、录屏、业务代码和真实页面。只有脚本修复验证通过后才会替换当前脚本；用例内容问题会生成待审核候选。",
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

      await writeExportWorkbook(rows);
      messageApi.success(`已导出 ${rows.length} 条用例`);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "导出用例失败");
    } finally {
      setExporting(false);
    }
  }

  function openImportFile() {
    importInputRef.current?.click();
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || currentProjectId == null) {
      return;
    }

    setImporting(true);
    try {
      const rows = await readImportWorkbook(file);
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
        <div className="mb-3 flex items-center justify-between">
          <Space>
            <Input.Search
              allowClear
              placeholder="输入用例名称搜索"
              className="w-72"
              onSearch={(value: string) => setTitleKeyword(value.trim())}
            />
            <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadTestCases()}>
              刷新
            </Button>
            <Button icon={<PlayCircleOutlined />} loading={runningAll} onClick={() => void handleRunAll()}>
              全量运行
            </Button>
            <Button onClick={() => navigate("/generate-cases")} disabled={currentProjectId == null}>
              AI 生成
            </Button>
          </Space>
          <Space>
            <Typography.Text type="secondary">已选择 {selectedRowKeys.length} 条</Typography.Text>
            <Button
              icon={<PlayCircleOutlined />}
              disabled={!selectedRowKeys.length}
              onClick={() => void handleBatchRun()}
            >
              批量运行
            </Button>
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={!selectedRowKeys.length}
              onClick={() => void handleBatchDelete()}
            >
              批量删除
            </Button>
            <Button
              icon={<ExportOutlined />}
              loading={exporting}
              disabled={!selectedRowKeys.length}
              onClick={() => void handleExportSelected()}
            >
              导出
            </Button>
            <Button icon={<ImportOutlined />} loading={importing} onClick={openImportFile}>
              导入
            </Button>
          </Space>
          <input
            ref={importInputRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(event) => void handleImportFile(event)}
          />
        </div>
        <Table<TestCaseListItem>
          rowKey="id"
          loading={loading}
          dataSource={items}
          pagination={{
            defaultPageSize: 10,
            pageSizeOptions: ["10", "20", "50", "100"],
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条`,
          }}
          rowSelection={{
            selectedRowKeys,
            onChange: (keys) => setSelectedRowKeys(keys.map(String)),
            getCheckboxProps: (record) => ({
              disabled: isBusyStatus(record.status),
            }),
          }}
          columns={[
            {
              title: "用例名称",
              dataIndex: "title",
              width: 220,
              ellipsis: true,
              render: (title: string, record) => (
                <Tooltip title={title}>
                  <Button type="link" className="!max-w-full !px-0" onClick={() => void openEditModal(record.id)}>
                    <span className="block truncate">{title}</span>
                  </Button>
                </Tooltip>
              ),
            },
            {
              title: "分组",
              dataIndex: "groupName",
              width: 120,
              filters: groupFilters,
              onFilter: (value, record) => record.groupName === value,
            },
            {
              title: "运行日志",
              width: 88,
              render: (_, record) => (
                <Tooltip title="查看运行日志">
                  <Button icon={<FileTextOutlined />} onClick={() => showRunLog(record)} />
                </Tooltip>
              ),
            },
            {
              title: "状态",
              dataIndex: "status",
              width: 120,
              filters: statusFilters,
              onFilter: (value, record) => record.status === value,
              render: (_, record) =>
                record.status === "failed" && record.lastFailureReason ? (
                  <Tooltip title={record.lastFailureReason}>
                    <span>
                      <StatusTag status={record.status} />
                    </span>
                  </Tooltip>
                ) : (
                  <StatusTag status={record.status} kind={record.activeRunKind} />
                ),
            },
            {
              title: "修复候选",
              width: 120,
              render: (_, record) => record.pendingRepairCandidateId ? (
                <Button type="link" className="!px-0" onClick={() => navigate(`/generate-cases?candidateId=${record.pendingRepairCandidateId}`)}>
                  待审核
                </Button>
              ) : "—",
            },
            {
              title: "需生成脚本",
              dataIndex: "scriptNeedsGeneration",
              width: 120,
              filters: [
                { text: "是", value: true },
                { text: "否", value: false },
              ],
              onFilter: (value, record) => record.scriptNeedsGeneration === value,
              render: (value: boolean) => <Tag color={value ? "gold" : "default"}>{value ? "是" : "否"}</Tag>,
            },
            {
              title: "最近运行时间",
              dataIndex: "lastRunAt",
              width: 160,
              render: (value: string | null) => formatDateTime(value),
            },
            {
              title: "最后更新时间",
              dataIndex: "editedAt",
              width: 160,
              render: (value: string | null) => formatDateTime(value),
            },
            {
              title: "操作",
              width: 150,
              fixed: "right",
              render: (_, record) => (
                <Space>
                  {isBusyStatus(record.status) ? (
                    <Tooltip title="停止">
                      <Button danger icon={<StopOutlined />} onClick={() => void handleStop(record)} />
                    </Tooltip>
                  ) : (
                    <>
                      <Tooltip title="运行">
                        <Button icon={<PlayCircleOutlined />} onClick={() => void handleRun(record)} />
                      </Tooltip>
                      {record.status === "failed" && !record.scriptNeedsGeneration && !record.pendingRepairCandidateId ? (
                        <Tooltip title="AI 修复">
                          <Button icon={<ToolOutlined />} onClick={() => handleRepair(record)} />
                        </Tooltip>
                      ) : null}
                      <Tooltip title="删除">
                        <Button danger icon={<DeleteOutlined />} onClick={() => void handleDelete(record)} />
                      </Tooltip>
                    </>
                  )}
                </Space>
              ),
            },
          ]}
          scroll={{ x: "max-content" }}
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

const statusFilters: ColumnType<TestCaseListItem>["filters"] = [
  { text: "未运行", value: "not_run" },
  { text: "排队中", value: "queued" },
  { text: "用例生成中", value: "generating" },
  { text: "运行中", value: "running" },
  { text: "成功", value: "success" },
  { text: "失败", value: "failed" },
];

function toFilters(values: string[]) {
  return Array.from(new Set(values)).map((value) => ({ text: value, value }));
}

async function writeExportWorkbook(rows: TestCaseExcelRow[]) {
  const XLSX = await import("xlsx");
  const worksheet = XLSX.utils.json_to_sheet(toExcelRecords(rows), {
    header: Object.values(EXCEL_COLUMNS),
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "用例");
  XLSX.writeFile(workbook, createExportFileName());
}

async function readImportWorkbook(file: File) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return [];
  }

  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[firstSheetName], { defval: "" });
  return records.map((record, index) => ({
    title: getExcelCellText(record, EXCEL_COLUMNS.title),
    groupName: getExcelCellText(record, EXCEL_COLUMNS.groupName),
    naturalLanguage: getExcelCellText(record, EXCEL_COLUMNS.naturalLanguage),
    rowNumber: index + 2,
  }));
}

function toExcelRecords(rows: TestCaseExcelRow[]) {
  return rows.map((row) => ({
    [EXCEL_COLUMNS.title]: row.title,
    [EXCEL_COLUMNS.groupName]: row.groupName,
    [EXCEL_COLUMNS.naturalLanguage]: row.naturalLanguage,
  }));
}

function getExcelCellText(record: Record<string, unknown>, column: string) {
  const value = record[column];
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function createExportFileName() {
  const now = new Date();
  const date = [
    now.getFullYear(),
    padDatePart(now.getMonth() + 1),
    padDatePart(now.getDate()),
  ].join("");
  const time = [padDatePart(now.getHours()), padDatePart(now.getMinutes()), padDatePart(now.getSeconds())].join("");
  return `用例导出_${date}_${time}.xlsx`;
}

function padDatePart(value: number) {
  return String(value).padStart(2, "0");
}
