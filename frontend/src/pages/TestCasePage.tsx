import { DeleteOutlined, FileTextOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, StopOutlined } from "@ant-design/icons";
import { Button, Descriptions, Empty, Input, Modal, Space, Table, Tabs, Tag, Tooltip, Typography, message } from "antd";
import type { ColumnType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toBackendUrl } from "../api/url";
import { createTestCaseGroup, fetchTestCaseGroups } from "../api/testCaseGroups";
import {
  createTestCase,
  deleteTestCase,
  deleteTestCases,
  fetchLatestRun,
  fetchTestCase,
  fetchTestCases,
  runTestCase,
  runTestCases,
  stopTestCase,
  updateTestCase,
} from "../api/testCases";
import { isBusyStatus, StatusTag } from "../components/StatusTag";
import { TestCaseModal } from "../components/TestCaseModal";
import type { LatestRunDetail, RunRequestResult, StopRunResult, TestCaseDetail, TestCaseGroup, TestCaseListItem, TestCasePayload } from "../types";

const ACTIVE_CASE_POLL_INTERVAL_MS = 5000;

export function TestCasePage() {
  const [items, setItems] = useState<TestCaseListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [groups, setGroups] = useState<TestCaseGroup[]>([]);
  const [titleKeyword, setTitleKeyword] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCase, setEditingCase] = useState<TestCaseDetail | null>(null);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [runLogItem, setRunLogItem] = useState<TestCaseListItem | null>(null);
  const [runDetail, setRunDetail] = useState<LatestRunDetail | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [runLogActiveTab, setRunLogActiveTab] = useState("overview");
  const [messageApi, contextHolder] = message.useMessage();
  const [modal, modalContextHolder] = Modal.useModal();

  const hasBusyCase = useMemo(() => items.some((item) => isBusyStatus(item.status)), [items]);
  const groupFilters = useMemo(() => toFilters(items.map((item) => item.groupName)), [items]);

  const loadTestCases = useCallback(async (showLoading = true) => {
    if (showLoading) {
      setLoading(true);
    }

    try {
      const testCases = await fetchTestCases(titleKeyword);
      setItems(testCases);
      setSelectedRowKeys((current) => current.filter((id) => testCases.some((item) => item.id === id)));
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载用例失败");
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [messageApi, titleKeyword]);

  const loadGroups = useCallback(async () => {
    try {
      setGroups(await fetchTestCaseGroups());
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载分组失败");
    }
  }, [messageApi]);

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
    try {
      const group = await createTestCaseGroup(name);
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
        content: "当前 Claude 小批次会一起停止，同批生成中的用例将标记为失败。",
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
      messageApi.success(`已停止当前生成小批次，共 ${result.affectedTestCaseIds.length} 条用例`);
      return;
    }

    messageApi.success("已停止用例");
  }

  function showRunRequestMessage(result: RunRequestResult, mode: "single" | "batch") {
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

  async function showRunLog(item: TestCaseListItem) {
    setRunLogItem(item);
    setRunDetail(null);
    setRunLogActiveTab("overview");
    await refreshRunLog(item.id);
  }

  async function refreshRunLog(testCaseId = runLogItem?.id) {
    if (!testCaseId) {
      return;
    }

    setRunDetailLoading(true);
    try {
      setRunDetail(await fetchLatestRun(testCaseId));
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载运行日志失败");
    } finally {
      setRunDetailLoading(false);
    }
  }

  function formatDateTime(value?: string | null) {
    return value ? new Date(value).toLocaleString() : "暂无";
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
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
          新增用例
        </Button>
      </div>

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
          </Space>
        </div>
        <Table<TestCaseListItem>
          rowKey="id"
          loading={loading}
          dataSource={items}
          pagination={{ pageSize: 8 }}
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
                  <Button icon={<FileTextOutlined />} onClick={() => void showRunLog(record)} />
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
                  <StatusTag status={record.status} />
                ),
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
              width: 100,
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

      <TestCaseModal
        open={modalOpen}
        loading={saving}
        initialValue={editingCase}
        groups={groups}
        onCancel={() => setModalOpen(false)}
        onSubmit={handleSubmit}
        onCreateGroup={handleCreateGroup}
      />

      <Modal
        title={
          <div className="flex items-center justify-between gap-3 pr-8">
            <span>运行日志</span>
            <Button size="small" icon={<ReloadOutlined />} loading={runDetailLoading} onClick={() => void refreshRunLog()}>
              刷新
            </Button>
          </div>
        }
        open={Boolean(runLogItem)}
        onCancel={() => {
          setRunLogItem(null);
          setRunDetail(null);
          setRunLogActiveTab("overview");
        }}
        footer={null}
        width={1040}
      >
        {runDetailLoading ? (
          <Typography.Text type="secondary">加载中...</Typography.Text>
        ) : runLogItem && runDetail?.runLog ? (
          <Tabs
            activeKey={runLogActiveTab}
            onChange={setRunLogActiveTab}
            items={[
              {
                key: "overview",
                label: "概览",
                children: (
                  <Descriptions column={1} size="small">
                    <Descriptions.Item label="用例名称">{runLogItem.title}</Descriptions.Item>
                    <Descriptions.Item label="分组">{runLogItem.groupName}</Descriptions.Item>
                    <Descriptions.Item label="状态">
                      <StatusTag status={runDetail.runLog.status} />
                    </Descriptions.Item>
                    <Descriptions.Item label="开始时间">{formatDateTime(runDetail.runLog.startedAt)}</Descriptions.Item>
                    <Descriptions.Item label="结束时间">{formatDateTime(runDetail.runLog.finishedAt)}</Descriptions.Item>
                    {runDetail.runLog.failureReason ? (
                      <Descriptions.Item label="失败原因">
                        <Typography.Paragraph className="!mb-0" copyable>
                          {runDetail.runLog.failureReason}
                        </Typography.Paragraph>
                      </Descriptions.Item>
                    ) : null}
                  </Descriptions>
                ),
              },
              {
                key: "output",
                label: "用例生成日志",
                children: <LogBlock title="用例生成日志" value={getGenerationLog(runDetail.runLog.stdout)} emptyText="该运行暂无用例生成日志" />,
              },
              {
                key: "report",
                label: "测试报告",
                children: runDetail.reportUrl ? (
                  <iframe title="Playwright HTML 报告" src={toBackendUrl(runDetail.reportUrl)} className="h-[560px] w-full rounded border border-gray-200" />
                ) : (
                  <Empty description="暂无测试报告" />
                ),
              },
            ]}
          />
        ) : (
          <Empty description="暂无运行日志" />
        )}
      </Modal>
    </div>
  );
}

function LogBlock({ title, value, emptyText = "暂无输出" }: { title: string; value?: string | null; emptyText?: string }) {
  return (
    <div>
      <Typography.Text strong>{title}</Typography.Text>
      <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-950 p-3 text-xs text-slate-100">
        {value || emptyText}
      </pre>
    </div>
  );
}

function getGenerationLog(stdout?: string | null) {
  return stdout?.startsWith("[用例生成日志]") ? stdout : null;
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
