import { Button, Card, Input, Space, Table, Typography, message } from "antd";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { generateTestCaseCandidates, importTestCases } from "../api/testCases";
import { useProject } from "../ProjectContext";
import type { TestCaseCandidate } from "../types";

// AI 基于项目代码仓库读代码生成用例候选 → 审核（编辑/勾选）→ 导入当前项目；导入后跳转用例管理。
export function GenerateCasesPage() {
  const { currentProjectId } = useProject();
  const navigate = useNavigate();
  const [candidates, setCandidates] = useState<TestCaseCandidate[]>([]);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [hint, setHint] = useState("");
  const [generating, setGenerating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  async function handleGenerate() {
    if (currentProjectId == null) {
      return;
    }
    setGenerating(true);
    try {
      const { candidates: list } = await generateTestCaseCandidates(currentProjectId, hint.trim() || undefined);
      setCandidates(list);
      setSelectedRowKeys(list.map((_, index) => String(index)));
      messageApi.success(`已生成 ${list.length} 条候选`);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  }

  function updateCandidate(index: number, patch: Partial<TestCaseCandidate>) {
    setCandidates((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  async function handleImport() {
    if (currentProjectId == null || !selectedRowKeys.length) {
      return;
    }
    setImporting(true);
    try {
      const selected = selectedRowKeys
        .map((key) => candidates[Number(key)])
        .filter(Boolean)
        .map(({ title, groupName, naturalLanguage }) => ({ title, groupName, naturalLanguage }));
      const result = await importTestCases(currentProjectId, selected);
      messageApi.success(`已导入 ${result.createdCount} 条，跳过 ${result.skippedCount} 条`);
      setCandidates([]);
      setSelectedRowKeys([]);
      navigate("/test-cases");
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-4">
      {contextHolder}
      <Typography.Title level={3}>AI 生成用例</Typography.Title>
      <Card>
        <Typography.Paragraph type="secondary">
          点击“生成候选”让 AI 基于项目代码仓库读代码生成用例（约 2-5 分钟）。生成后可编辑、勾选，再导入选中的到当前项目。
        </Typography.Paragraph>
        <Input.TextArea
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          placeholder="生成要求（可选）：如只生成登录和用户管理模块、生成 20 条、关注异常分支等"
          autoSize={{ minRows: 2, maxRows: 4 }}
        />
        <Space className="mt-4">
          <Button onClick={handleGenerate} loading={generating} disabled={currentProjectId == null}>
            生成候选
          </Button>
          <Button type="primary" onClick={handleImport} loading={importing} disabled={!selectedRowKeys.length}>
            导入选中（{selectedRowKeys.length}）
          </Button>
        </Space>
      </Card>
      <Card title={`候选用例（${candidates.length}）`}>
        <Table<TestCaseCandidate>
          rowKey={(_, index) => String(index)}
          dataSource={candidates}
          pagination={false}
          scroll={{ y: 480 }}
          rowSelection={{
            selectedRowKeys,
            onChange: (keys) => setSelectedRowKeys(keys.map(String)),
          }}
          columns={[
            {
              title: "标题",
              dataIndex: "title",
              width: 160,
              render: (value: string, _record, index) => (
                <Input value={value} onChange={(e) => updateCandidate(index, { title: e.target.value })} />
              ),
            },
            {
              title: "分组",
              dataIndex: "groupName",
              width: 120,
              render: (value: string, _record, index) => (
                <Input value={value} onChange={(e) => updateCandidate(index, { groupName: e.target.value })} />
              ),
            },
            {
              title: "自然语言步骤",
              dataIndex: "naturalLanguage",
              render: (value: string, _record, index) => (
                <Input.TextArea
                  value={value}
                  autoSize={{ minRows: 2 }}
                  onChange={(e) => updateCandidate(index, { naturalLanguage: e.target.value })}
                />
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
