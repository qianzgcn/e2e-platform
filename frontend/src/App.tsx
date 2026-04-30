import { DashboardOutlined, ProjectOutlined, SettingOutlined } from "@ant-design/icons";
import { ConfigProvider, Layout, Menu, Typography } from "antd";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { DashboardPage } from "./pages/DashboardPage";
import { ProjectSettingsPage } from "./pages/ProjectSettingsPage";
import { TestCasePage } from "./pages/TestCasePage";

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const selectedKey = location.pathname === "/" ? "/dashboard" : location.pathname;

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
            selectedKeys={[selectedKey]}
            onClick={({ key }) => navigate(key)}
            items={[
              { key: "/dashboard", icon: <DashboardOutlined />, label: "看板" },
              { key: "/test-cases", icon: <ProjectOutlined />, label: "用例管理" },
              { key: "/settings", icon: <SettingOutlined />, label: "配置" },
            ]}
          />
        </Layout.Sider>
        <Layout>
          <Layout.Content className="px-8 py-7">
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/test-cases" element={<TestCasePage />} />
              <Route path="/settings" element={<ProjectSettingsPage />} />
            </Routes>
          </Layout.Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}
