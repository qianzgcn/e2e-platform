import { loadPrompt } from "./loadPrompt.js";

export type ScriptSource = {
  title: string;
  id: string;
  naturalLanguage: string;
};

const SCRIPT_OUTPUT_DIR = "tests/generated";

export function loadScriptGenerationSystemPrompt() {
  return loadPrompt("script-generation.system.md");
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

function normalizeInstruction(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}
