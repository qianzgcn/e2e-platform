import { z } from "zod";
import { loadSystemPrompt } from "./loadPrompt.js";

const testCaseCandidateSchema = z
  .object({
    title: z.string().trim().min(1),
    groupName: z.string().trim().min(1),
    naturalLanguage: z.string().trim().min(1),
  })
  .strict();

const testCaseCandidatesSchema = z.array(testCaseCandidateSchema).min(1);

export type TestCaseCandidate = z.infer<typeof testCaseCandidateSchema>;

export type CaseGenerationSafetyFeedback = {
  candidateNumber: number;
  candidate: TestCaseCandidate;
  problem: string;
  suggestion: string;
};

type CaseGenerationProject = {
  variables: Array<{ name: string }>;
  promptHint: string | null;
};

export function loadCaseGenerationSystemPrompt() {
  return loadSystemPrompt("case-generation.system.md");
}

export function buildCaseGenerationPrompt(
  project: CaseGenerationProject,
  hint?: string,
): string {
  return JSON.stringify(buildCaseGenerationInput(project, hint), null, 2);
}

export function buildCaseGenerationSafetyCorrectionPrompt(
  project: CaseGenerationProject,
  hint: string | undefined,
  unsafeCandidates: CaseGenerationSafetyFeedback[],
): string {
  return JSON.stringify(
    {
      mode: "correct_test_data_safety",
      ...buildCaseGenerationInput(project, hint),
      unsafeCandidates,
    },
    null,
    2,
  );
}

function buildCaseGenerationInput(
  project: CaseGenerationProject,
  hint?: string,
) {
  const variablePlaceholders = project.variables
    .map((variable) => variable.name.trim())
    .filter(Boolean)
    .map((name) => `\${${name}}`);

  return {
    variablePlaceholders,
    projectInstructions: normalizeInstruction(project.promptHint),
    requestInstructions: normalizeInstruction(hint),
  };
}

export function parseTestCaseCandidates(text: string): TestCaseCandidate[] {
  const json = extractJsonArray(text);
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("AI 返回的内容无法解析为 JSON");
  }

  const result = testCaseCandidatesSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("AI 返回的候选用例格式不符合要求");
  }

  return result.data;
}

// 兼容接口偶尔附带的代码围栏或说明文字，格式校验仍由 Zod 严格执行。
function extractJsonArray(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const arrayMatch = raw.match(/\[[\s\S]*\]/);

  if (!arrayMatch) {
    throw new Error("AI 返回内容中未找到 JSON 数组");
  }

  return arrayMatch[0];
}

function normalizeInstruction(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}
