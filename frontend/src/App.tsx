import { DashboardOutlined, ProjectOutlined, SettingOutlined } from "@ant-design/icons";
import { ConfigProvider, Layout, Menu, Typography } from "antd";
import type { ReactNode } from "react";
import { useState } from "react";
import { DashboardPage } from "./pages/DashboardPage";
import { ProjectSettingsPage } from "./pages/ProjectSettingsPage";
import { TestCasePage } from "./pages/TestCasePage";

type PageKey = "dashboard" | "testCases" | "settings";

const pageMap: Record<PageKey, ReactNode> = {
  dashboard: <DashboardPage />,
  testCases: <TestCasePage />,
  settings: <ProjectSettingsPage />,
};

export default function App() {
  const [page, setPage] = useState<PageKey>("dashboard");

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#2563eb",
          borderRadius: 8,
          fontFamily:
            "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        },
      }}
    >
      <Layout className="app-shell">
        <Layout.Sider width={232} theme="light" className="border-r border-gray-200">
          <div className="px-5 py-5">
            <Typography.Title level={4} className="!mb-0">
              AI 测试平台
            </Typography.Title>
            <Typography.Text type="secondary">E2E Automation</Typography.Text>
          </div>
          <Menu
            mode="inline"
            selectedKeys={[page]}
            onClick={({ key }) => setPage(key as PageKey)}
            items={[
              { key: "dashboard", icon: <DashboardOutlined />, label: "看板" },
              { key: "testCases", icon: <ProjectOutlined />, label: "用例管理" },
              { key: "settings", icon: <SettingOutlined />, label: "配置" },
            ]}
          />
        </Layout.Sider>
        <Layout>
          <Layout.Content className="px-8 py-7">{pageMap[page]}</Layout.Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}
