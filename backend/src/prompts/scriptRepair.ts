import { z } from "zod";
import { loadPrompt } from "./loadPrompt.js";

const nonEmptyText = z.string().trim().min(1);

const scriptRepairResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("script_repair"),
    summary: nonEmptyText,
  }).strict(),
  z.object({
    outcome: z.literal("case_repair"),
    problem: nonEmptyText,
    suggestion: nonEmptyText,
    naturalLanguage: nonEmptyText,
  }).strict(),
  z.object({
    outcome: z.literal("unrepairable"),
    category: z.enum(["business", "data", "permission", "environment"]),
    problem: nonEmptyText,
    suggestion: nonEmptyText,
  }).strict(),
]);

export type ScriptRepairResult = z.infer<typeof scriptRepairResultSchema>;

export type ScriptRepairPromptInput = {
  baseUrl: string;
  targetFile: string;
  businessRepository: string | null;
  projectInstructions: string | null;
  testCase: {
    id: string;
    title: string;
    originalNaturalLanguage: string;
    resolvedNaturalLanguage: string;
  };
  currentScript: string;
  sourceFailure: {
    runLogId: number;
    failureReason: string | null;
    stdout: string | null;
    stderr: string | null;
    artifactPaths: string[];
    videoFramePaths: string[];
  };
};

export function loadScriptRepairSystemPrompt() {
  return loadPrompt("script-repair.system.md");
}

export function buildScriptRepairPrompt(input: ScriptRepairPromptInput): string {
  return JSON.stringify(input, null, 2);
}

export function parseScriptRepairResult(text: string): ScriptRepairResult {
  const match = text.match(/<script-repair-result>\s*([\s\S]*?)\s*<\/script-repair-result>/);
  if (!match) {
    throw new Error("AI 未返回完整的修复结果");
  }

  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    throw new Error("AI 返回的修复结果不是合法 JSON");
  }

  const parsed = scriptRepairResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`AI 返回的修复结果格式无效：${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export function assertNoProjectVariableValues(
  naturalLanguage: string,
  variables: Array<{ name: string; value: string }>,
) {
  const exposedVariable = variables.find((variable) => variable.value && naturalLanguage.includes(variable.value));
  if (exposedVariable) {
    throw new Error(`AI 修复候选包含变量 ${exposedVariable.name} 的真实值，已拒绝保存`);
  }
}

export function assertPreservesVariablePlaceholders(source: string, candidate: string) {
  const sourceNames = collectVariablePlaceholderNames(source);
  const candidateNames = new Set(collectVariablePlaceholderNames(candidate));
  const missingName = sourceNames.find((name) => !candidateNames.has(name));
  if (missingName) {
    throw new Error(`AI 修复候选缺少原用例变量 \${${missingName}}，已拒绝保存`);
  }
}

export function redactProjectVariableValues(
  value: string,
  variables: Array<{ name: string; value: string }>,
) {
  return [...variables]
    .filter((variable) => variable.value)
    .sort((left, right) => right.value.length - left.value.length)
    .reduce(
      (current, variable) => current.replaceAll(variable.value, `\${${variable.name}}`),
      value,
  );
}

function collectVariablePlaceholderNames(value: string) {
  return Array.from(value.matchAll(/\$\{([^}]+)\}/g))
    .map((match) => match[1].trim())
    .filter(Boolean);
}
