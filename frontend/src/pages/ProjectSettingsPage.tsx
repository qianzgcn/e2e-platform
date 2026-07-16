import { PlusOutlined } from "@ant-design/icons";
import { Button, Empty, Tabs, Typography, message } from "antd";
import { useEffect, useState } from "react";
import { ProjectConfigurationForm } from "../components/project-settings/ProjectConfigurationForm";
import { EMPTY_PROJECT_FORM, type ProjectFormValues } from "../components/project-settings/projectForm";
import { ProjectListPanel } from "../components/project-settings/ProjectListPanel";
import {
  createProject,
  deleteProject,
  fetchAutomationAdapters,
  testRepoConnectivity,
  updateProject,
  type ProjectPayload,
} from "../api/project";
import { useProject } from "../projectContextState";
import type { ProjectConfig } from "../types";

type SettingsTab = "configuration" | "projects";

export function ProjectSettingsPage() {
  const {
    projects,
    currentProjectId,
    setCurrentProjectId,
    reloadProjects,
  } = useProject();
  const [activeTab, setActiveTab] = useState<SettingsTab>("configuration");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingRepo, setTestingRepo] = useState(false);
  const [automationAdapters, setAutomationAdapters] = useState<string[]>([]);
  const [messageApi, contextHolder] = message.useMessage();
  const currentProject = projects.find((project) => project.id === currentProjectId) ?? null;

  useEffect(() => {
    let cancelled = false;
    void fetchAutomationAdapters()
      .then((adapters) => {
        if (!cancelled) setAutomationAdapters(adapters);
      })
      .catch((error) => {
        if (!cancelled) {
          messageApi.error(error instanceof Error ? error.message : "加载自动化 Adapter 失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [messageApi]);

  function openCreate() {
    setCreating(true);
    setActiveTab("configuration");
  }

  function openConfiguration(project: ProjectConfig) {
    setCreating(false);
    setCurrentProjectId(project.id);
    setActiveTab("configuration");
  }

  async function handleSubmit(values: ProjectFormValues) {
    if (!creating && !currentProject) return;

    setSaving(true);
    try {
      const payload: ProjectPayload = { ...values, variables: values.variables ?? [] };
      const savedProject = creating
        ? await createProject(payload)
        : await updateProject(currentProject!.id, payload);

      await reloadProjects();
      setCurrentProjectId(savedProject.id);
      setCreating(false);
      messageApi.success(creating ? "项目已创建" : "项目配置已保存");
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "保存项目失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestRepo(source: Pick<ProjectFormValues, "repoUrl" | "repoBranch" | "repoSubdirectory">) {
    if (!source.repoUrl?.trim()) {
      messageApi.warning("请先输入代码仓库 URL");
      return;
    }

    setTestingRepo(true);
    try {
      const result = await testRepoConnectivity({
        repoUrl: source.repoUrl.trim(),
        repoBranch: source.repoBranch?.trim() || null,
        repoSubdirectory: source.repoSubdirectory?.trim() || null,
      });
      if (result.ok) messageApi.success(result.message);
      else messageApi.error(result.message);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "测试失败");
    } finally {
      setTestingRepo(false);
    }
  }

  async function handleDelete(project: ProjectConfig) {
    try {
      await deleteProject(project.id);
      await reloadProjects();
      messageApi.success("项目已删除");
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : "删除项目失败");
    }
  }

  const initialValues = creating
    ? EMPTY_PROJECT_FORM
    : currentProject
      ? toProjectFormValues(currentProject)
      : EMPTY_PROJECT_FORM;
  const formKey = creating ? "new-project" : `project-${currentProject?.id ?? "none"}`;

  return (
    <div className="space-y-5">
      {contextHolder}
      <div>
        <Typography.Title level={3} className="!mb-1">
          配置
        </Typography.Title>
        <Typography.Text type="secondary">维护当前项目的测试配置，或在项目列表中管理多个被测项目</Typography.Text>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as SettingsTab)}
        items={[
          { key: "configuration", label: "项目配置" },
          { key: "projects", label: `项目列表（${projects.length}）` },
        ]}
      />

      {activeTab === "configuration" && (
        creating || currentProject ? (
          <ProjectConfigurationForm
            key={formKey}
            title={creating ? "新建项目" : currentProject!.name}
            initialValues={initialValues}
            automationAdapters={automationAdapters}
            creating={creating}
            saving={saving}
            testingRepo={testingRepo}
            onSubmit={handleSubmit}
            onTestRepo={handleTestRepo}
            onCancelCreate={() => setCreating(false)}
          />
        ) : (
          <div className="content-panel py-16">
            <Empty description="暂无项目，请先创建一个被测项目">
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                新建项目
              </Button>
            </Empty>
          </div>
        )
      )}

      {activeTab === "projects" && (
        <ProjectListPanel
          projects={projects}
          currentProjectId={currentProjectId}
          onCreate={openCreate}
          onConfigure={openConfiguration}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}

function toProjectFormValues(project: ProjectConfig): ProjectFormValues {
  return {
    name: project.name,
    baseUrl: project.baseUrl,
    repoUrl: project.repoUrl ?? "",
    repoBranch: project.repoBranch ?? "",
    repoSubdirectory: project.repoSubdirectory ?? "",
    promptHint: project.promptHint ?? "",
    automationHint: project.automationHint ?? "",
    automationAdapterKey: project.automationAdapterKey ?? null,
    variables: project.variables ?? [],
  };
}
