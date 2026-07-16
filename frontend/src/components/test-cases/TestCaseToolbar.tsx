import {
  DeleteOutlined,
  ExportOutlined,
  ImportOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { Button, Input, Space, Typography } from "antd";
import type { ChangeEvent } from "react";
import { useRef } from "react";

type TestCaseToolbarProps = {
  loading: boolean;
  runningAll: boolean;
  exporting: boolean;
  importing: boolean;
  selectedCount: number;
  onSearch: (value: string) => void;
  onRefresh: () => void;
  onRunAll: () => void;
  onGenerate: () => void;
  onBatchRun: () => void;
  onBatchDelete: () => void;
  onExport: () => void;
  onImportFile: (file: File) => Promise<void>;
};

export function TestCaseToolbar({
  loading,
  runningAll,
  exporting,
  importing,
  selectedCount,
  onSearch,
  onRefresh,
  onRunAll,
  onGenerate,
  onBatchRun,
  onBatchDelete,
  onExport,
  onImportFile,
}: TestCaseToolbarProps) {
  const importInputRef = useRef<HTMLInputElement>(null);

  function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) {
      void onImportFile(file);
    }
  }

  return (
    <div className="mb-3 flex items-center justify-between">
      <Space>
        <Input.Search
          allowClear
          placeholder="输入用例名称搜索"
          className="w-72"
          onSearch={(value: string) => onSearch(value.trim())}
        />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>
          刷新
        </Button>
        <Button icon={<PlayCircleOutlined />} loading={runningAll} onClick={onRunAll}>
          全量运行
        </Button>
        <Button onClick={onGenerate}>AI 生成</Button>
      </Space>
      <Space>
        <Typography.Text type="secondary">已选择 {selectedCount} 条</Typography.Text>
        <Button icon={<PlayCircleOutlined />} disabled={!selectedCount} onClick={onBatchRun}>
          批量运行
        </Button>
        <Button danger icon={<DeleteOutlined />} disabled={!selectedCount} onClick={onBatchDelete}>
          批量删除
        </Button>
        <Button icon={<ExportOutlined />} loading={exporting} disabled={!selectedCount} onClick={onExport}>
          导出
        </Button>
        <Button icon={<ImportOutlined />} loading={importing} onClick={() => importInputRef.current?.click()}>
          导入
        </Button>
      </Space>
      <input
        ref={importInputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={handleImportFile}
      />
    </div>
  );
}
