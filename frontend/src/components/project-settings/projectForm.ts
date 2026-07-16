export type ProjectFormValues = {
  name: string;
  baseUrl: string;
  repoUrl: string;
  repoBranch: string;
  repoSubdirectory: string;
  promptHint: string;
  automationHint: string;
  automationAdapterKey: string | null;
  variables: Array<{ name: string; value: string; description?: string | null }>;
};

export const EMPTY_PROJECT_FORM: ProjectFormValues = {
  name: "",
  baseUrl: "",
  repoUrl: "",
  repoBranch: "",
  repoSubdirectory: "",
  promptHint: "",
  automationHint: "",
  automationAdapterKey: null,
  variables: [],
};
