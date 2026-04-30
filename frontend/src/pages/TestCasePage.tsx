import { DeleteOutlined, FileTextOutlined, PlayCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Descriptions, Empty, Input, Modal, Space, Table, Tabs, Tooltip, Typography, message } from "antd";
import type { ColumnType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  updateTestCase,
} from "../api/testCases";
import { isBusyStatus, StatusTag } from "../components/StatusTag";
import { TestCaseModal } from "../components/TestCaseModal";
import type { LatestRunDetail, TestCaseDetail, TestCaseGroup, TestCaseListItem, TestCasePayload } from "../types";

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
  const [messageApi, contextHolder] = message.useMessage();

  const hasBusyCase = useMemo(() => items.some((item) => isBusyStatus(item.status)), [items]);
  const groupFilters = useMemo(() => toFilters(items.map((item) => item.groupName)), [items]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [testCases, testCaseGroups] = await Promise.all([fetchTestCases(titleKeyword), fetchTestCaseGroups()]);
      setItems(testCases);
      setGroups(testCaseGroups);
      setSelectedRowKeys((current) => current.filter((id) => testCases.some((item) => item.id === id)));
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载用例失败");
    } finally {
      setLoading(false);
    }
  }, [messageApi, titleKeyword]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!hasBusyCase) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadData();
    }, 2000);

    return () => window.clearInterval(timer);
  }, [hasBusyCase, loadData]);

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
      await loadData();
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
      await runTestCase(item.id);
      messageApi.success("已加入运行队列");
      await loadData();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "运行失败");
    }
  }

  async function handleDelete(item: TestCaseListItem) {
    Modal.confirm({
      title: "删除用例",
      content: `确认删除「${item.title}」吗？`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        await deleteTestCase(item.id);
        await loadData();
      },
    });
  }

  async function handleBatchRun() {
    if (!selectedRowKeys.length) {
      return;
    }

    try {
      await runTestCases(selectedRowKeys);
      messageApi.success("已加入运行队列");
      setSelectedRowKeys([]);
      await loadData();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "批量运行失败");
    }
  }

  async function handleBatchDelete() {
    if (!selectedRowKeys.length) {
      return;
    }

    Modal.confirm({
      title: "批量删除用例",
      content: `确认删除选中的 ${selectedRowKeys.length} 条用例吗？`,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        await deleteTestCases(selectedRowKeys);
        setSelectedRowKeys([]);
        await loadData();
      },
    });
  }

  async function showRunLog(item: TestCaseListItem) {
    setRunLogItem(item);
    setRunDetail(null);
    setRunDetailLoading(true);
    try {
      setRunDetail(await fetchLatestRun(item.id));
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
            <Typography.Text type="secondary">已选择 {selectedRowKeys.length} 条</Typography.Text>
          </Space>
          <Space>
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
              width: 160,
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
              width: 104,
              fixed: "right",
              render: (_, record) => (
                <Space>
                  <Tooltip title="运行">
                    <Button
                      icon={<PlayCircleOutlined />}
                      disabled={isBusyStatus(record.status)}
                      onClick={() => void handleRun(record)}
                    />
                  </Tooltip>
                  <Tooltip title="删除">
                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      disabled={isBusyStatus(record.status)}
                      onClick={() => void handleDelete(record)}
                    />
                  </Tooltip>
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
        title="运行日志"
        open={Boolean(runLogItem)}
        onCancel={() => {
          setRunLogItem(null);
          setRunDetail(null);
        }}
        footer={null}
        width={1040}
      >
        {runDetailLoading ? (
          <Typography.Text type="secondary">加载中...</Typography.Text>
        ) : runLogItem && runDetail?.runLog ? (
          <Tabs
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
                label: "输出",
                children: (
                  <div className="space-y-4">
                    <LogBlock title="stdout" value={runDetail.runLog.stdout} />
                    <LogBlock title="stderr" value={runDetail.runLog.stderr} />
                  </div>
                ),
              },
              {
                key: "report",
                label: "测试报告",
                children: runDetail.reportUrl ? (
                  <iframe title="Playwright HTML 报告" src={toApiUrl(runDetail.reportUrl)} className="h-[560px] w-full rounded border border-gray-200" />
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

function LogBlock({ title, value }: { title: string; value?: string | null }) {
  return (
    <div>
      <Typography.Text strong>{title}</Typography.Text>
      <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-950 p-3 text-xs text-slate-100">
        {value || "暂无输出"}
      </pre>
    </div>
  );
}

function toApiUrl(url: string) {
  return url.startsWith("http") ? url : `http://localhost:3001${url}`;
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
