import { DeleteOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Form, Input, Select, Space, Typography } from "antd";
import type { ProjectFormValues } from "./projectForm";

type ProjectConfigurationFormProps = {
  title: string;
  initialValues: ProjectFormValues;
  automationAdapters: string[];
  creating: boolean;
  saving: boolean;
  testingRepo: boolean;
  onSubmit: (values: ProjectFormValues) => Promise<void>;
  onTestRepo: (repoUrl: string) => Promise<void>;
  onCancelCreate: () => void;
};

export function ProjectConfigurationForm({
  title,
  initialValues,
  automationAdapters,
  creating,
  saving,
  testingRepo,
  onSubmit,
  onTestRepo,
  onCancelCreate,
}: ProjectConfigurationFormProps) {
  const [form] = Form.useForm<ProjectFormValues>();

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={initialValues}
      onFinish={(values) => void onSubmit(values)}
      scrollToFirstError
      className="space-y-5"
    >
      <section className="content-panel overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-6 py-5">
          <div>
            <Typography.Title level={4} className="!mb-1">
              {title}
            </Typography.Title>
            <Typography.Text type="secondary">
              {creating ? "填写被测项目、AI 约束和自动化复用能力" : "修改后保存即可应用到后续用例生成、运行和修复"}
            </Typography.Text>
          </div>
          <Space>
            {creating && <Button onClick={onCancelCreate}>取消</Button>}
            <Button type="primary" htmlType="submit" loading={saving}>
              {creating ? "创建项目" : "保存配置"}
            </Button>
          </Space>
        </div>

        <div className="space-y-8 p-6">
          <div>
            <Typography.Title level={5} className="!mb-1">
              基本信息
            </Typography.Title>
            <Typography.Text type="secondary">被测服务地址和只读代码仓库</Typography.Text>

            <div className="mt-4 grid grid-cols-1 gap-x-5 lg:grid-cols-2">
              <Form.Item name="name" label="项目名称" rules={[{ required: true, message: "请输入项目名称" }]}>
                <Input placeholder="例如：测试平台" />
              </Form.Item>
              <Form.Item name="baseUrl" label="baseUrl" rules={[{ required: true, message: "请输入 baseUrl" }]}>
                <Input placeholder="http://localhost:5173" />
              </Form.Item>
            </div>

            <Form.Item label="代码仓库 URL" tooltip="AI 只读取该仓库，用于理解业务代码和页面实现">
              <Space.Compact block>
                <Form.Item name="repoUrl" noStyle>
                  <Input placeholder="https://github.com/owner/repo.git" />
                </Form.Item>
                <Button
                  loading={testingRepo}
                  onClick={() => void onTestRepo(form.getFieldValue("repoUrl"))}
                >
                  测试连通性
                </Button>
              </Space.Compact>
            </Form.Item>
          </div>

          <div className="border-t border-gray-200 pt-7">
            <Typography.Title level={5} className="!mb-1">
              AI 与自动化约束
            </Typography.Title>
            <Typography.Text type="secondary">区分业务规则、自动化交互规则与稳定复用代码</Typography.Text>

            <div className="mt-4 grid grid-cols-1 gap-x-5 xl:grid-cols-2">
              <Form.Item
                name="promptHint"
                label="业务与用例约束"
                tooltip="自然语言用例生成、脚本生成和 AI 修复共同遵守"
              >
                <Input.TextArea
                  placeholder="如：角色权限、业务前置条件、不可修改的数据范围和关键业务规则"
                  autoSize={{ minRows: 6, maxRows: 14 }}
                />
              </Form.Item>

              <Form.Item
                name="automationHint"
                label="自动化执行约束"
                tooltip="只用于 Playwright 脚本生成和 AI 修复，不影响自然语言候选生成"
              >
                <Input.TextArea
                  placeholder="如：UI 组件库、交互约定，以及应调用 Adapter 的场景；不要填写敏感值"
                  autoSize={{ minRows: 6, maxRows: 14 }}
                />
              </Form.Item>
            </div>

            <Form.Item
              name="automationAdapterKey"
              label="自动化 Adapter"
              tooltip="选择平台内已安装的项目级复用能力；配置后脚本生成和 AI 修复必须导入使用"
              extra="切换 Adapter 会使当前项目已有 Playwright 脚本失效，历史运行日志和产物仍会保留。"
            >
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="未配置时由 AI 根据真实页面生成项目交互"
                options={automationAdapters.map((key) => ({ label: key, value: key }))}
              />
            </Form.Item>
          </div>

          <div className="border-t border-gray-200 pt-7">
            <Form.List name="variables">
              {(fields, { add, remove }) => (
                <>
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <Typography.Title level={5} className="!mb-1">
                        项目变量
                      </Typography.Title>
                      <Typography.Text type="secondary">自然语言用例中通过 {"${变量名}"} 引用，值不会进入候选生成提示词</Typography.Text>
                    </div>
                    <Button icon={<PlusOutlined />} onClick={() => add({ name: "", value: "", description: "" })}>
                      新增变量
                    </Button>
                  </div>

                  {fields.length > 0 && (
                    <div className="mb-2 hidden grid-cols-[minmax(160px,0.8fr)_minmax(220px,1.2fr)_minmax(220px,1fr)_40px] gap-3 px-1 text-sm text-gray-500 md:grid">
                      <span>变量名</span>
                      <span>变量值</span>
                      <span>说明</span>
                      <span />
                    </div>
                  )}

                  <div className="space-y-3">
                    {fields.map((field) => (
                      <div
                        key={field.key}
                        className="grid grid-cols-1 gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 md:grid-cols-[minmax(160px,0.8fr)_minmax(220px,1.2fr)_minmax(220px,1fr)_40px]"
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
                          <Input placeholder="变量用途说明" />
                        </Form.Item>
                        <Button
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          aria-label="删除变量"
                          onClick={() => remove(field.name)}
                        />
                      </div>
                    ))}
                    {fields.length === 0 && (
                      <div className="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-gray-500">
                        暂无项目变量
                      </div>
                    )}
                  </div>
                </>
              )}
            </Form.List>
          </div>
        </div>
      </section>
    </Form>
  );
}
