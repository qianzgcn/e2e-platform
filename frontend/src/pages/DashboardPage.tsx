import { FileTextOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, Empty, Row, Statistic, Table, Tooltip, Typography, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchDashboard } from "../api/dashboard";
import { createTestCaseGroup, fetchTestCaseGroups } from "../api/testCaseGroups";
import { fetchTestCase, updateTestCase } from "../api/testCases";
import { RunLogModal } from "../components/RunLogModal";
import { TestCaseModal } from "../components/TestCaseModal";
import { useProject } from "../projectContextState";
import type { DashboardData, TestCaseDetail, TestCaseGroup, TestCasePayload } from "../types";
import { formatDateTime } from "../utils/date";

export function DashboardPage() {
  const navigate = useNavigate();
  const { currentProjectId } = useProject();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [groups, setGroups] = useState<TestCaseGroup[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [editingCase, setEditingCase] = useState<TestCaseDetail | null>(null);
  const [caseModalOpen, setCaseModalOpen] = useState(false);
  const [runLogItem, setRunLogItem] = useState<DashboardData["recentFailedCases"][number] | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const loadData = useCallback(async () => {
    if (currentProjectId == null) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      setData(await fetchDashboard(currentProjectId));
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载看板失败");
    } finally {
      setLoading(false);
    }
  }, [currentProjectId, messageApi]);

  useEffect(() => {
    setGroupsLoaded(false);
    void loadData();
  }, [loadData]);

  async function ensureGroupsLoaded() {
    if (groupsLoaded || currentProjectId == null) {
      return;
    }
    setGroups(await fetchTestCaseGroups(currentProjectId));
    setGroupsLoaded(true);
  }

  async function openEditModal(id: string) {
    try {
      const [testCase] = await Promise.all([fetchTestCase(id), ensureGroupsLoaded()]);
      setEditingCase(testCase);
      setCaseModalOpen(true);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载用例详情失败");
    }
  }

  async function handleSubmit(data: TestCasePayload) {
    if (!editingCase) {
      return;
    }
    setSaving(true);
    try {
      await updateTestCase(editingCase.id, data);
      setCaseModalOpen(false);
      await loadData();
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

  return (
    <div className="space-y-5">
      {contextHolder}
      <div>
        <Typography.Title level={3} className="!mb-1">
          看板
        </Typography.Title>
        <Typography.Text type="secondary">查看用例最新运行结果和失败情况</Typography.Text>
      </div>

      {currentProjectId == null ? (
        <Alert
          type="info"
          showIcon
          message="请先在配置页新建并选择一个项目"
          action={
            <Button size="small" onClick={() => navigate("/settings")}>
              去配置
            </Button>
          }
        />
      ) : (
        <>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Card bordered={false}>
                <Statistic
                  title="成功率"
                  value={data?.successRate ?? 0}
                  suffix="%"
                  loading={loading}
                  valueStyle={{ color: getSuccessRateColor(data?.successRate ?? 0) }}
                />
              </Card>
            </Col>
            <Col xs={24} md={12}>
              <Card bordered={false} hoverable className="cursor-pointer" onClick={() => navigate("/test-cases")}>
                <Statistic title="用例总数" value={data?.totalCases ?? 0} loading={loading} />
              </Card>
            </Col>
          </Row>

          <div className="content-panel p-4">
            <div className="mb-3 flex items-center justify-between">
              <Typography.Title level={5} className="!mb-0">
                最近失败用例
              </Typography.Title>
            </div>
            {data?.recentFailedCases.length ? (
              <Table<DashboardData["recentFailedCases"][number]>
                rowKey="id"
                loading={loading}
                pagination={false}
                dataSource={data.recentFailedCases}
                columns={[
                  {
                    title: "用例名称",
                    dataIndex: "title",
                    render: (title: string, record) => (
                      <Tooltip title={title}>
                        <Button type="link" className="!max-w-full !px-0" onClick={() => void openEditModal(record.id)}>
                          <span className="block truncate">{title}</span>
                        </Button>
                      </Tooltip>
                    ),
                  },
                  { title: "分组", dataIndex: "groupName", width: 180 },
                  {
                    title: "运行日志",
                    width: 88,
                    render: (_, record) => (
                      <Tooltip title="查看运行日志">
                        <Button icon={<FileTextOutlined />} onClick={() => setRunLogItem(record)} />
                      </Tooltip>
                    ),
                  },
                  {
                    title: "运行时间",
                    dataIndex: "lastRunAt",
                    width: 180,
                    render: (value: string | null) => formatDateTime(value),
                  },
                ]}
              />
            ) : (
              <Empty description="暂无失败用例" />
            )}
          </div>

          <Alert type="info" showIcon message="成功率只统计每个用例的最新一次运行状态" />
        </>
      )}

      <TestCaseModal
        open={caseModalOpen}
        loading={saving}
        initialValue={editingCase}
        groups={groups}
        onCancel={() => setCaseModalOpen(false)}
        onSubmit={handleSubmit}
        onCreateGroup={handleCreateGroup}
      />
      <RunLogModal target={runLogItem} onClose={() => setRunLogItem(null)} />
    </div>
  );
}

function getSuccessRateColor(value: number) {
  if (value === 100) {
    return "#16a34a";
  }

  return value >= 50 ? "#d97706" : "#dc2626";
}
