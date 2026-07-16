import {
  DeleteOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  StopOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { Button, Space, Table, Tag, Tooltip } from "antd";
import type { ColumnType } from "antd/es/table";
import type { TestCaseListItem } from "../../types";
import { formatDateTime } from "../../utils/date";
import { isBusyStatus } from "../../utils/testCaseStatus";
import { StatusTag } from "../StatusTag";

type TestCaseTableProps = {
  items: TestCaseListItem[];
  loading: boolean;
  selectedRowKeys: string[];
  onSelectionChange: (keys: string[]) => void;
  onEdit: (id: string) => void;
  onShowLog: (item: TestCaseListItem) => void;
  onReviewCandidate: (candidateId: number) => void;
  onStop: (item: TestCaseListItem) => void;
  onRun: (item: TestCaseListItem) => void;
  onRepair: (item: TestCaseListItem) => void;
  onDelete: (item: TestCaseListItem) => void;
};

const statusFilters: ColumnType<TestCaseListItem>["filters"] = [
  { text: "未运行", value: "not_run" },
  { text: "排队中", value: "queued" },
  { text: "用例生成中", value: "generating" },
  { text: "运行中", value: "running" },
  { text: "成功", value: "success" },
  { text: "失败", value: "failed" },
];

export function TestCaseTable({
  items,
  loading,
  selectedRowKeys,
  onSelectionChange,
  onEdit,
  onShowLog,
  onReviewCandidate,
  onStop,
  onRun,
  onRepair,
  onDelete,
}: TestCaseTableProps) {
  const groupFilters = Array.from(new Set(items.map((item) => item.groupName))).map((value) => ({
    text: value,
    value,
  }));

  return (
    <Table<TestCaseListItem>
      className="test-case-table"
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
        onChange: (keys) => onSelectionChange(keys.map(String)),
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
              <Button type="link" className="!max-w-full !px-0" onClick={() => onEdit(record.id)}>
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
              <Button icon={<FileTextOutlined />} onClick={() => onShowLog(record)} />
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
            <Button type="link" className="!px-0" onClick={() => onReviewCandidate(record.pendingRepairCandidateId!)}>
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
                  <Button danger icon={<StopOutlined />} onClick={() => onStop(record)} />
                </Tooltip>
              ) : (
                <>
                  <Tooltip title="运行">
                    <Button icon={<PlayCircleOutlined />} onClick={() => onRun(record)} />
                  </Tooltip>
                  {record.status === "failed" && !record.pendingRepairCandidateId ? (
                    <Tooltip title="AI 修复">
                      <Button icon={<ToolOutlined />} onClick={() => onRepair(record)} />
                    </Tooltip>
                  ) : null}
                  <Tooltip title="删除">
                    <Button danger icon={<DeleteOutlined />} onClick={() => onDelete(record)} />
                  </Tooltip>
                </>
              )}
            </Space>
          ),
        },
      ]}
      scroll={{ x: "max-content", y: "100%" }}
    />
  );
}
