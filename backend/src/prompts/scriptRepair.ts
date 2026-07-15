import { z } from "zod";
import { loadSystemPrompt } from "./loadPrompt.js";

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
export type ScriptRepairMode = "script_or_case" | "case_only";

export type ScriptRepairPromptInput = {
  repairMode: ScriptRepairMode;
  baseUrl: string;
  targetFile: string | null;
  businessRepository: string | null;
  projectInstructions: string | null;
  testCase: {
    id: string;
    title: string;
    originalNaturalLanguage: string;
    resolvedNaturalLanguage: string | null;
    protectedVariablePlaceholders: string[];
  };
  currentScript: string | null;
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
  return loadSystemPrompt("script-repair.system.md");
}

export function buildScriptRepairPrompt(
  input: ScriptRepairPromptInput,
  variables: Array<{ name: string; value: string }> = [],
): string {
  if (input.repairMode !== "case_only") {
    return JSON.stringify(input, null, 2);
  }

  const redact = (value: string | null) => value == null
    ? null
    : redactProjectVariableValues(value, variables);
  return JSON.stringify({
    ...input,
    targetFile: null,
    testCase: {
      ...input.testCase,
      resolvedNaturalLanguage: null,
    },
    currentScript: null,
    sourceFailure: {
      ...input.sourceFailure,
      failureReason: redact(input.sourceFailure.failureReason),
      stdout: redact(input.sourceFailure.stdout),
      stderr: redact(input.sourceFailure.stderr),
    },
  }, null, 2);
}

export function parseScriptRepairResult(
  text: string,
  repairMode: ScriptRepairMode = "script_or_case",
): ScriptRepairResult {
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
  if (repairMode === "case_only" && parsed.data.outcome === "script_repair") {
    throw new Error("当前用例没有可修复的 Playwright 脚本，AI 必须返回自然语言修复候选或不可修复结论");
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

export function assertUsesOnlySourceVariablePlaceholders(source: string, candidate: string) {
  const sourceNames = new Set(collectVariablePlaceholderNames(source));
  const unknownName = collectVariablePlaceholderNames(candidate).find((name) => !sourceNames.has(name));
  if (unknownName) {
    throw new Error(`AI 修复候选引入了原用例未配置的变量 \${${unknownName}}，已拒绝保存`);
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
