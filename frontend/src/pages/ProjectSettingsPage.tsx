import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Drawer, Form, Input, Popconfirm, Space, Table, Typography, message } from "antd";
import { useEffect, useState } from "react";
import { createProject, deleteProject, testRepoConnectivity, updateProject, type ProjectPayload } from "../api/project";
import { useProject } from "../ProjectContext";
import type { ProjectConfig } from "../types";

type ProjectForm = {
  name: string;
  baseUrl: string;
  repoUrl: string;
  promptHint: string;
  variables: Array<{ name: string; value: string; description?: string | null }>;
};

const EMPTY_FORM: ProjectForm = { name: "", baseUrl: "", repoUrl: "", promptHint: "", variables: [] };

export function ProjectSettingsPage() {
  const { projects, reloadProjects } = useProject();
  const [form] = Form.useForm<ProjectForm>();
  const [editing, setEditing] = useState<ProjectConfig | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingRepo, setTestingRepo] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    void reloadProjects();
  }, [reloadProjects]);

  function openCreate() {
    setEditing(null);
    form.setFieldsValue(EMPTY_FORM);
    setDrawerOpen(true);
  }

  function openEdit(project: ProjectConfig) {
    setEditing(project);
    form.setFieldsValue({
      name: project.name,
      baseUrl: project.baseUrl,
      repoUrl: project.repoUrl ?? "",
      promptHint: project.promptHint ?? "",
      variables: project.variables ?? [],
    });
    setDrawerOpen(true);
  }

  async function handleSubmit(values: ProjectForm) {
    setSaving(true);
    try {
      const payload: ProjectPayload = { ...values, variables: values.variables ?? [] };
      if (editing) {
        await updateProject(editing.id, payload);
        messageApi.success("项目已更新");
      } else {
        await createProject(payload);
        messageApi.success("项目已创建");
      }
      setDrawerOpen(false);
      await reloadProjects();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "保存项目失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestRepo() {
    const repoUrl = form.getFieldValue("repoUrl");
    if (!repoUrl?.trim()) {
      messageApi.warning("请先输入代码仓库 URL");
      return;
    }
    setTestingRepo(true);
    try {
      const result = await testRepoConnectivity(repoUrl.trim());
      if (result.ok) {
        messageApi.success(result.message);
      } else {
        messageApi.error(result.message);
      }
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "测试失败");
    } finally {
      setTestingRepo(false);
    }
  }

  async function handleDelete(project: ProjectConfig) {
    try {
      await deleteProject(project.id);
      messageApi.success("项目已删除");
      await reloadProjects();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "删除项目失败");
    }
  }

  return (
    <div className="space-y-5">
      {contextHolder}
      <div className="flex items-center justify-between">
        <div>
          <Typography.Title level={3} className="!mb-1">
            项目管理
          </Typography.Title>
          <Typography.Text type="secondary">维护多个被测项目及其 baseUrl 与变量</Typography.Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新建项目
        </Button>
      </div>

      <div className="content-panel p-4">
        <Table<ProjectConfig>
          rowKey="id"
          dataSource={projects}
          pagination={false}
          columns={[
            { title: "项目名称", dataIndex: "name" },
            { title: "baseUrl", dataIndex: "baseUrl" },
            {
              title: "变量数",
              width: 100,
              render: (_, record) => record.variables?.length ?? 0,
            },
            {
              title: "操作",
              width: 160,
              render: (_, record) => (
                <Space>
                  <Button size="small" onClick={() => openEdit(record)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除项目"
                    description="确认删除该项目吗？项目下有用例时无法删除。"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => void handleDelete(record)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </div>

      <Drawer title={editing ? "编辑项目" : "新建项目"} open={drawerOpen} onClose={() => setDrawerOpen(false)} width={560} destroyOnClose>
        <Form layout="vertical" form={form} onFinish={handleSubmit} initialValues={EMPTY_FORM}>
          <Form.Item name="name" label="项目名称" rules={[{ required: true, message: "请输入项目名称" }]}>
            <Input placeholder="例如：测试平台" />
          </Form.Item>
          <Form.Item name="baseUrl" label="baseUrl" rules={[{ required: true, message: "请输入 baseUrl" }]}>
            <Input placeholder="http://localhost:5173" />
          </Form.Item>
          <Form.Item label="代码仓库 URL" tooltip="AI 生成用例时 clone 该仓库读代码">
            <Space.Compact style={{ width: "100%" }}>
              <Form.Item name="repoUrl" noStyle>
                <Input placeholder="https://github.com/owner/repo.git" />
              </Form.Item>
              <Button onClick={() => void handleTestRepo()} loading={testingRepo}>
                测试连通性
              </Button>
            </Space.Compact>
          </Form.Item>

          <Form.Item name="promptHint" label="项目业务约束" tooltip="AI 生成用例时遵守，如角色、特殊规则">
            <Input.TextArea
              placeholder="如：系统有三种角色（管理员/项目经理/项目成员），不同用例需用对应角色账号；新增类用例必须幂等"
              autoSize={{ minRows: 2, maxRows: 6 }}
            />
          </Form.Item>

          <Form.List name="variables">
            {(fields, { add, remove }) => (
              <>
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <Typography.Title level={5} className="!mb-0">
                      变量组
                    </Typography.Title>
                    <Typography.Text type="secondary">用例中通过 {"${变量名}"} 引用变量值</Typography.Text>
                  </div>
                  <Button icon={<PlusOutlined />} onClick={() => add({ name: "", value: "", description: "" })}>
                    新增变量
                  </Button>
                </div>
                <div className="space-y-3">
                  {fields.map((field) => (
                    <div
                      key={field.key}
                      className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_1fr_40px]"
                    >
                      <Form.Item
                        name={[field.name, "name"]}
                        className="!mb-0"
                        rules={[{ required: true, message: "请输入变量名" }]}
                      >
                        <Input placeholder="例如 username" />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, "value"]}
                        className="!mb-0"
                        rules={[{ required: true, message: "请输入变量值" }]}
                      >
                        <Input.Password placeholder="变量值" autoComplete="new-password" />
                      </Form.Item>
                      <Form.Item name={[field.name, "description"]} className="!mb-0">
                        <Input placeholder="说明" />
                      </Form.Item>
                      <Button danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                    </div>
                  ))}
                  {fields.length === 0 && <Typography.Text type="secondary">暂无变量</Typography.Text>}
                </div>
              </>
            )}
          </Form.List>

          <div className="mt-6">
            <Button type="primary" htmlType="submit" loading={saving}>
              保存
            </Button>
          </div>
        </Form>
      </Drawer>
    </div>
  );
}
