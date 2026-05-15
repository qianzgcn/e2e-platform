import { ReloadOutlined } from "@ant-design/icons";
import { Button, Descriptions, Empty, Modal, Tabs, Typography, message } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLatestRun } from "../api/testCases";
import { toBackendUrl } from "../api/url";
import type { LatestRunDetail } from "../types";
import { formatDateTime } from "../utils/date";
import { StatusTag } from "./StatusTag";

export type RunLogTarget = {
  id: string;
  title: string;
  groupName?: string | null;
};

type RunLogModalProps = {
  target: RunLogTarget | null;
  onClose: () => void;
};

export function RunLogModal({ target, onClose }: RunLogModalProps) {
  const [detail, setDetail] = useState<LatestRunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const requestIdRef = useRef(0);
  const [messageApi, contextHolder] = message.useMessage();

  const loadRunLog = useCallback(
    async (testCaseId: string) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setLoading(true);
      try {
        const nextDetail = await fetchLatestRun(testCaseId);
        if (requestId === requestIdRef.current) {
          setDetail(nextDetail);
        }
      } catch (error) {
        if (requestId === requestIdRef.current) {
          messageApi.error(error instanceof Error ? error.message : "加载运行日志失败");
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [messageApi],
  );

  useEffect(() => {
    if (!target) {
      requestIdRef.current += 1;
      setDetail(null);
      setLoading(false);
      setActiveTab("overview");
      return;
    }

    setDetail(null);
    setActiveTab("overview");
    void loadRunLog(target.id);
  }, [loadRunLog, target]);

  function handleClose() {
    requestIdRef.current += 1;
    onClose();
    setDetail(null);
    setLoading(false);
    setActiveTab("overview");
  }

  return (
    <>
      {contextHolder}
      <Modal
        title={
          <div className="flex items-center justify-between gap-3 pr-8">
            <span>运行日志</span>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={loading}
              disabled={!target}
              onClick={() => target && void loadRunLog(target.id)}
            >
              刷新
            </Button>
          </div>
        }
        open={Boolean(target)}
        onCancel={handleClose}
        footer={null}
        width={1040}
      >
        {loading ? (
          <Typography.Text type="secondary">加载中...</Typography.Text>
        ) : target && detail?.runLog ? (
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
              {
                key: "overview",
                label: "概览",
                children: (
                  <Descriptions column={1} size="small">
                    <Descriptions.Item label="用例名称">{target.title}</Descriptions.Item>
                    <Descriptions.Item label="分组">{target.groupName || "暂无"}</Descriptions.Item>
                    <Descriptions.Item label="状态">
                      <StatusTag status={detail.runLog.status} />
                    </Descriptions.Item>
                    <Descriptions.Item label="开始时间">{formatDateTime(detail.runLog.startedAt)}</Descriptions.Item>
                    <Descriptions.Item label="结束时间">{formatDateTime(detail.runLog.finishedAt)}</Descriptions.Item>
                    {detail.runLog.failureReason ? (
                      <Descriptions.Item label="失败原因">
                        <Typography.Paragraph className="!mb-0" copyable>
                          {detail.runLog.failureReason}
                        </Typography.Paragraph>
                      </Descriptions.Item>
                    ) : null}
                  </Descriptions>
                ),
              },
              {
                key: "output",
                label: "用例生成日志",
                children: (
                  <LogBlock
                    title="用例生成日志"
                    value={getGenerationLog(detail.runLog.stdout)}
                    emptyText="该运行暂无用例生成日志"
                  />
                ),
              },
              {
                key: "report",
                label: "测试报告",
                children: detail.reportUrl ? (
                  <iframe
                    title="Playwright HTML 报告"
                    src={toBackendUrl(detail.reportUrl)}
                    className="h-[560px] w-full rounded border border-gray-200"
                  />
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
    </>
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
