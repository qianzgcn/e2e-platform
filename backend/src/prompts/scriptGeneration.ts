import { loadSystemPrompt } from "./loadPrompt.js";

export type ScriptSource = {
  title: string;
  id: string;
  originalNaturalLanguage: string;
  naturalLanguage: string;
  protectedVariablePlaceholders: string[];
};

export type ScriptGenerationError = {
  problem: string;
  suggestion: string;
};

const SCRIPT_OUTPUT_DIR = "tests/generated";
const ERROR_START_TAG = "<script-generation-error>";
const ERROR_END_TAG = "</script-generation-error>";

export function loadScriptGenerationSystemPrompt() {
  return loadSystemPrompt("script-generation.system.md");
}

export function buildScriptGenerationPrompt(
  testCase: ScriptSource,
  baseUrl: string,
  projectInstructions?: string | null,
): string {
  return JSON.stringify(
    {
      baseUrl,
      outputDir: SCRIPT_OUTPUT_DIR,
      projectInstructions: normalizeInstruction(projectInstructions),
      testCase,
    },
    null,
    2,
  );
}

export function parseScriptGenerationError(result: string): ScriptGenerationError | null {
  const block = result.match(
    /<script-generation-error>\s*问题：([\s\S]*?)\s*修改建议：([\s\S]*?)\s*<\/script-generation-error>/,
  );

  if (!block) {
    if (result.includes(ERROR_START_TAG) || result.includes(ERROR_END_TAG)) {
      throw new Error("Agent 返回的用例问题格式不完整");
    }
    return null;
  }

  const problem = block[1].trim();
  const suggestion = block[2].trim();
  if (!problem || !suggestion) {
    throw new Error("Agent 返回的用例问题缺少问题描述或修改建议");
  }

  return { problem, suggestion };
}

function normalizeInstruction(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}
