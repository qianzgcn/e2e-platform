import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input, Typography, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { fetchProject, saveProject } from "../api/project";

type ProjectForm = {
  name: string;
  baseUrl: string;
  variables: Array<{
    name: string;
    value: string;
    description?: string | null;
  }>;
};

export function ProjectSettingsPage() {
  const [form] = Form.useForm<ProjectForm>();
  const [loading, setLoading] = useState(false);
  const [hasProject, setHasProject] = useState(true);
  const [messageApi, contextHolder] = message.useMessage();

  const loadProject = useCallback(async () => {
    setLoading(true);
    try {
      const project = await fetchProject();

      if (!project) {
        setHasProject(false);
        form.setFieldsValue({
          name: "",
          baseUrl: "",
          variables: [],
        });
        return;
      }

      setHasProject(true);
      form.setFieldsValue({
        name: project.name,
        baseUrl: project.baseUrl,
        variables: project.variables ?? [],
      });
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "加载配置失败");
    } finally {
      setLoading(false);
    }
  }, [form, messageApi]);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  async function handleSubmit(values: ProjectForm) {
    setLoading(true);
    try {
      await saveProject({ ...values, variables: values.variables ?? [] });
      setHasProject(true);
      messageApi.success("配置已保存");
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "保存配置失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      {contextHolder}
      <div>
        <Typography.Title level={3} className="!mb-1">
          配置
        </Typography.Title>
        <Typography.Text type="secondary">维护当前项目的基础信息</Typography.Text>
      </div>

      <div className="content-panel max-w-5xl p-5">
        {!hasProject ? (
          <Alert
            className="mb-4"
            type="info"
            showIcon
            message="当前没有项目配置"
            description="请填写项目名称和 baseUrl，保存后会创建项目配置。"
          />
        ) : null}

        <Form layout="vertical" form={form} onFinish={handleSubmit}>
          <Form.Item name="name" label="项目名称" rules={[{ required: true, message: "请输入项目名称" }]}>
            <Input placeholder="例如：测试平台" />
          </Form.Item>
          <Form.Item name="baseUrl" label="baseUrl" rules={[{ required: true, message: "请输入 baseUrl" }]}>
            <Input placeholder="http://localhost:5173" />
          </Form.Item>

          <div className="mb-4">
            <Form.List name="variables">
              {(fields, { add, remove }) => (
                <>
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <Typography.Title level={5} className="!mb-0">
                        变量组
                      </Typography.Title>
                      <Typography.Text type="secondary">用例中可以通过 {"${变量名}"} 引用变量值</Typography.Text>
                    </div>
                    <Button icon={<PlusOutlined />} onClick={() => add({ name: "", value: "", description: "" })}>
                      新增变量
                    </Button>
                  </div>

                  <div className="space-y-3">
                    {fields.length > 0 && (
                      <div className="hidden grid-cols-[minmax(140px,1fr)_minmax(200px,1.3fr)_minmax(180px,1fr)_40px] gap-3 text-xs text-gray-500 md:grid">
                        <span>变量名</span>
                        <span>变量值</span>
                        <span>说明</span>
                        <span />
                      </div>
                    )}
                    {fields.map((field) => (
                      <div
                        key={field.key}
                        className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(140px,1fr)_minmax(200px,1.3fr)_minmax(180px,1fr)_40px]"
                      >
                        <Form.Item
                          key={`${field.key}-name`}
                          name={[field.name, "name"]}
                          className="!mb-0"
                          rules={[{ required: true, message: "请输入变量名" }]}
                        >
                          <Input placeholder="例如 username" />
                        </Form.Item>
                        <Form.Item
                          key={`${field.key}-value`}
                          name={[field.name, "value"]}
                          className="!mb-0"
                          rules={[{ required: true, message: "请输入变量值" }]}
                        >
                          <Input.Password placeholder="变量值" autoComplete="new-password" />
                        </Form.Item>
                        <Form.Item
                          key={`${field.key}-description`}
                          name={[field.name, "description"]}
                          className="!mb-0"
                        >
                          <Input/>
                        </Form.Item>
                        <Button danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                      </div>
                    ))}
                    {fields.length === 0 && <Typography.Text type="secondary">暂无变量</Typography.Text>}
                  </div>
                </>
              )}
            </Form.List>
          </div>

          <Button type="primary" htmlType="submit" loading={loading}>
            保存配置
          </Button>
        </Form>
      </div>
    </div>
  );
}
