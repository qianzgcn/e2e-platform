import { DashboardOutlined, ProjectOutlined, RobotOutlined, SettingOutlined } from "@ant-design/icons";
import { ConfigProvider, Layout, Menu, Select, Typography } from "antd";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ProjectProvider } from "./ProjectContext";
import { useProject } from "./projectContextState";
import { DashboardPage } from "./pages/DashboardPage";
import { GenerateCasesPage } from "./pages/GenerateCasesPage";
import { ProjectSettingsPage } from "./pages/ProjectSettingsPage";
import { TestCasePage } from "./pages/TestCasePage";

// 顶部项目切换框；切换后所有页面按当前 projectId 重新加载。
function ProjectSwitcher() {
  const { projects, currentProjectId, setCurrentProjectId, loading } = useProject();
  return (
    <Select
      loading={loading}
      value={currentProjectId ?? undefined}
      placeholder="选择项目"
      showSearch
      optionFilterProp="label"
      style={{ width: 240 }}
      options={projects.map((project) => ({ value: project.id, label: project.name }))}
      onChange={(value: number) => setCurrentProjectId(value)}
    />
  );
}

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
      <ProjectProvider>
        <Layout className="app-shell">
          <Layout.Sider width={232} theme="light" className="app-shell-sider border-r border-gray-200">
            <div className="px-5 py-5">
              <Typography.Title level={4} className="!mb-0">
                AI 测试平台
              </Typography.Title>
            </div>
            <Menu
              mode="inline"
              selectedKeys={[selectedKey]}
              onClick={({ key }) => navigate(key)}
              items={[
                { key: "/dashboard", icon: <DashboardOutlined />, label: "看板" },
                { key: "/test-cases", icon: <ProjectOutlined />, label: "用例管理" },
                { key: "/generate-cases", icon: <RobotOutlined />, label: "AI 生成用例" },
                { key: "/settings", icon: <SettingOutlined />, label: "配置" },
              ]}
            />
          </Layout.Sider>
          <Layout className="app-shell-main">
            <Layout.Header className="app-shell-header flex items-center border-b border-gray-200 bg-white px-6">
              <ProjectSwitcher />
            </Layout.Header>
            <Layout.Content className="app-shell-content px-8 py-7">
              <Routes>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/test-cases" element={<TestCasePage />} />
                <Route path="/generate-cases" element={<GenerateCasesPage />} />
                <Route path="/settings" element={<ProjectSettingsPage />} />
              </Routes>
            </Layout.Content>
          </Layout>
        </Layout>
      </ProjectProvider>
    </ConfigProvider>
  );
}
