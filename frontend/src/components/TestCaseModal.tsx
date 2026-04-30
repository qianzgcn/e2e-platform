import { CodeOutlined, DownOutlined, UpOutlined } from "@ant-design/icons";
import { Button, Col, Form, Input, Modal, Row, Select, Space } from "antd";
import { useEffect, useState } from "react";
import type { TestCaseDetail, TestCaseGroup, TestCasePayload } from "../types";

type Props = {
  open: boolean;
  loading?: boolean;
  initialValue?: TestCaseDetail | null;
  groups: TestCaseGroup[];
  onCancel: () => void;
  onSubmit: (data: TestCasePayload) => Promise<void>;
  onCreateGroup: (name: string) => Promise<TestCaseGroup>;
};

export function TestCaseModal({ open, loading, initialValue, groups, onCancel, onSubmit, onCreateGroup }: Props) {
  const [form] = Form.useForm<TestCasePayload>();
  const [groupName, setGroupName] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [showScript, setShowScript] = useState(false);
  const isEdit = Boolean(initialValue);

  useEffect(() => {
    if (!open) {
      return;
    }

    setShowScript(false);
    setGroupName("");
    form.resetFields();
    form.setFieldsValue({
      title: initialValue?.title ?? "",
      groupId: initialValue?.groupId,
      naturalLanguage: initialValue?.naturalLanguage ?? "",
      playwrightScript: initialValue?.playwrightScript ?? "",
    });
  }, [form, initialValue, open]);

  async function handleOk() {
    const values = await form.validateFields();
    await onSubmit(values);
  }

  async function handleCreateGroup() {
    if (!groupName) {
      return;
    }

    setCreatingGroup(true);
    try {
      const group = await onCreateGroup(groupName);
      form.setFieldValue("groupId", group.id);
      setGroupName("");
    } catch {
      return;
    } finally {
      setCreatingGroup(false);
    }
  }

  return (
    <Modal
      title={isEdit ? "编辑用例" : "新增用例"}
      open={open}
      onCancel={onCancel}
      onOk={handleOk}
      confirmLoading={loading}
      width={showScript ? "calc(100vw - 80px)" : 640}
      centered
      className={showScript ? "test-case-modal-wide" : ""}
      styles={{
        body: showScript
          ? {
              maxHeight: "calc(100vh - 180px)",
              overflow: "hidden",
            }
          : undefined,
      }}
      destroyOnClose
    >
      <Form layout="vertical" form={form} className={showScript ? "test-case-modal-form mt-4" : "mt-4"}>
        <Row gutter={16} className={showScript ? "test-case-modal-grid" : ""}>
          <Col span={showScript ? 12 : 24} className={showScript ? "test-case-modal-column" : ""}>
            <Form.Item name="title" label="用例名称" rules={[{ required: true, message: "请输入用例名称" }]}>
              <Input placeholder="例如：登录成功后进入控制台" />
            </Form.Item>

            <Form.Item name="groupId" label="分组" rules={[{ required: true, message: "请选择分组" }]}>
              <Select
                placeholder="请选择分组"
                options={groups.map((group) => ({ label: group.name, value: group.id }))}
              />
            </Form.Item>

            <Space.Compact className="mb-6 w-full">
              <Input
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                placeholder="新建分组，例如：登录模块"
              />
              <Button loading={creatingGroup} onClick={() => void handleCreateGroup()}>
                新建分组
              </Button>
            </Space.Compact>

            <Form.Item
              name="naturalLanguage"
              label="测试步骤"
              className={showScript ? "test-case-steps-item" : ""}
              rules={[{ required: true, message: "请输入测试步骤" }]}
            >
              <Input.TextArea
                className={showScript ? "test-case-steps-editor" : ""}
                rows={showScript ? 16 : 12}
                placeholder="用自然语言描述端到端测试步骤"
              />
            </Form.Item>

            <Space>
              <Button
                icon={<CodeOutlined />}
                onClick={() => setShowScript((value) => !value)}
              >
                {showScript ? "隐藏脚本" : "显示脚本"}
                {showScript ? <UpOutlined /> : <DownOutlined />}
              </Button>
            </Space>
          </Col>

          {showScript ? (
            <Col span={12} className="test-case-script-column">
              <Form.Item name="playwrightScript" label="Playwright 脚本" className="test-case-script-item">
                <Input.TextArea className="code-editor" placeholder="AI agent 生成后会写入这里，也可以手动编辑" />
              </Form.Item>
            </Col>
          ) : null}
        </Row>
      </Form>
    </Modal>
  );
}
