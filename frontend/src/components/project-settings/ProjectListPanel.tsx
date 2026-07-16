import { DeleteOutlined, PlusOutlined, SettingOutlined } from "@ant-design/icons";
import { Button, Popconfirm, Space, Table, Tag } from "antd";
import type { ProjectConfig } from "../../types";

type ProjectListPanelProps = {
  projects: ProjectConfig[];
  currentProjectId: number | null;
  onCreate: () => void;
  onConfigure: (project: ProjectConfig) => void;
  onDelete: (project: ProjectConfig) => Promise<void>;
};

export function ProjectListPanel({
  projects,
  currentProjectId,
  onCreate,
  onConfigure,
  onDelete,
}: ProjectListPanelProps) {
  return (
    <section className="content-panel p-4">
      <div className="mb-4 flex justify-end">
        <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
          新建项目
        </Button>
      </div>

      <Table<ProjectConfig>
        rowKey="id"
        dataSource={projects}
        pagination={false}
        locale={{ emptyText: "暂无项目，请先新建项目" }}
        columns={[
          {
            title: "项目名称",
            dataIndex: "name",
            render: (name: string, record) => (
              <Space>
                <span>{name}</span>
                {record.id === currentProjectId && <Tag color="blue">当前项目</Tag>}
              </Space>
            ),
          },
          { title: "baseUrl", dataIndex: "baseUrl" },
          {
            title: "Adapter",
            dataIndex: "automationAdapterKey",
            width: 160,
            render: (key: string | null | undefined) => key || "未配置",
          },
          {
            title: "变量数",
            width: 100,
            render: (_, record) => record.variables?.length ?? 0,
          },
          {
            title: "操作",
            width: 210,
            render: (_, record) => (
              <Space>
                <Button icon={<SettingOutlined />} onClick={() => onConfigure(record)}>
                  配置
                </Button>
                <Popconfirm
                  title="删除项目"
                  description="确认删除该项目吗？项目下有用例时无法删除。"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => onDelete(record)}
                >
                  <Button danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </section>
  );
}
