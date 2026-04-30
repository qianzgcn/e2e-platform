import { Button, Form, Input, Typography, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { fetchProject, saveProject } from "../api/project";

type ProjectForm = {
  name: string;
  baseUrl: string;
};

export function ProjectSettingsPage() {
  const [form] = Form.useForm<ProjectForm>();
  const [loading, setLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  const loadProject = useCallback(async () => {
    setLoading(true);
    try {
      const project = await fetchProject();
      form.setFieldsValue(project);
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
      await saveProject(values);
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

      <div className="content-panel max-w-3xl p-5">
        <Form layout="vertical" form={form} onFinish={handleSubmit}>
          <Form.Item name="name" label="项目名称" rules={[{ required: true, message: "请输入项目名称" }]}>
            <Input placeholder="默认项目" />
          </Form.Item>
          <Form.Item name="baseUrl" label="baseUrl" rules={[{ required: true, message: "请输入 baseUrl" }]}>
            <Input placeholder="http://localhost:5173" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading}>
            保存配置
          </Button>
        </Form>
      </div>
    </div>
  );
}

