import { Button, Card, Input, Modal, Space, Table, Typography, message } from "antd";
import { useEffect, useState } from "react";
import { fetchCandidates, fetchGenerationLogs, generateTestCaseCandidates, importCandidates } from "../api/testCases";
import { useProject } from "../ProjectContext";
import type { TestCaseCandidate, TestCaseGeneration } from "../types";

export function GenerateCasesPage() {
  const { currentProjectId } = useProject();
  const [candidates, setCandidates] = useState<TestCaseCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [hint, setHint] = useState("");
  const [generating, setGenerating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [latestGenerationId, setLatestGenerationId] = useState<number | null>(null);
  const [generation, setGeneration] = useState<TestCaseGeneration | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  async function loadCandidates() {
    if (currentProjectId == null) {
      setCandidates([]);
      return;
    }
    try {
      const { candidates: list } = await fetchCandidates(currentProjectId);
      setCandidates(list);
      setSelectedIds(list.map((candidate) => candidate.id));
      if (list.length) {
        setLatestGenerationId(list[list.length - 1].generationId);
      }
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载候选失败");
    }
  }

  useEffect(() => {
    void loadCandidates();
  }, [currentProjectId]);

  async function handleGenerate() {
    if (currentProjectId == null) {
      return;
    }
    setGenerating(true);
    try {
      const { generationId } = await generateTestCaseCandidates(currentProjectId, hint.trim() || undefined);
      setLatestGenerationId(generationId);
      messageApi.success("生成完成");
      await loadCandidates();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  }

  function updateCandidate(id: number, patch: Partial<TestCaseCandidate>) {
    setCandidates((current) => current.map((candidate) => (candidate.id === id ? { ...candidate, ...patch } : candidate)));
  }

  async function handleImport() {
    if (!selectedIds.length) {
      return;
    }
    setImporting(true);
    try {
      const selected = candidates.filter((candidate) => selectedIds.includes(candidate.id));
      const result = await importCandidates(selected);
      messageApi.success(`已导入 ${result.createdCount} 条，跳过 ${result.skippedCount} 条`);
      await loadCandidates();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setImporting(false);
    }
  }

  async function handleViewLogs() {
    if (latestGenerationId == null) {
      return;
    }
    setLoadingLogs(true);
    try {
      const gen = await fetchGenerationLogs(latestGenerationId);
      setGeneration(gen);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载日志失败");
    } finally {
      setLoadingLogs(false);
    }
  }

  return (
    <div className="space-y-4">
      {contextHolder}
      <Typography.Title level={3}>AI 生成用例</Typography.Title>
      <Card>
        <Typography.Paragraph type="secondary">AI 读取项目代码仓库生成用例候选，勾选后导入。生成约需 2-5 分钟。</Typography.Paragraph>
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
          <Button onClick={handleViewLogs} disabled={latestGenerationId == null} loading={loadingLogs}>
            查看最近生成日志
          </Button>
          <Button type="primary" onClick={handleImport} loading={importing} disabled={!selectedIds.length}>
            导入选中（{selectedIds.length}）
          </Button>
        </Space>
      </Card>
      <Card title={`候选用例（${candidates.length}）`}>
        <Table<TestCaseCandidate>
          rowKey="id"
          dataSource={candidates}
          pagination={false}
          scroll={{ y: 480 }}
          rowSelection={{
            selectedRowKeys: selectedIds,
            onChange: (keys) => setSelectedIds(keys.map(Number)),
          }}
          columns={[
            {
              title: "标题",
              dataIndex: "title",
              width: 160,
              render: (value: string, record) => (
                <Input value={value} onChange={(e) => updateCandidate(record.id, { title: e.target.value })} />
              ),
            },
            {
              title: "分组",
              dataIndex: "groupName",
              width: 120,
              render: (value: string, record) => (
                <Input value={value} onChange={(e) => updateCandidate(record.id, { groupName: e.target.value })} />
              ),
            },
            {
              title: "自然语言步骤",
              dataIndex: "naturalLanguage",
              render: (value: string, record) => (
                <Input.TextArea
                  value={value}
                  autoSize={{ minRows: 2 }}
                  onChange={(e) => updateCandidate(record.id, { naturalLanguage: e.target.value })}
                />
              ),
            },
          ]}
        />
      </Card>
      <Modal title="生成日志" open={generation !== null} onCancel={() => setGeneration(null)} footer={null} width={720}>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-sm">{generation?.logs}</pre>
      </Modal>
    </div>
  );
}
