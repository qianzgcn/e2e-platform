import { Alert, Card, Col, Empty, Row, Statistic, Table, Typography, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { fetchDashboard } from "../api/dashboard";
import type { DashboardData } from "../types";

export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchDashboard());
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载看板失败");
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  return (
    <div className="space-y-5">
      {contextHolder}
      <div>
        <Typography.Title level={3} className="!mb-1">
          看板
        </Typography.Title>
        <Typography.Text type="secondary">查看用例最新运行结果和失败情况</Typography.Text>
      </div>

      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Card bordered={false}>
            <Statistic title="成功率" value={data?.successRate ?? 0} suffix="%" loading={loading} />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card bordered={false}>
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
              { title: "用例名称", dataIndex: "title" },
              { title: "分组", dataIndex: "groupName", width: 180 },
              { title: "失败原因", dataIndex: "failureReason" },
            ]}
          />
        ) : (
          <Empty description="暂无失败用例" />
        )}
      </div>

      <Alert
        type="info"
        showIcon
        message="成功率只统计每个用例的最新一次运行状态"
      />
    </div>
  );
}
