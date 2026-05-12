type ScriptGenerationInput = {
  scriptNeedsGeneration: boolean;
  playwrightScript: string | null;
};

type ScriptGenerationSaveInput = ScriptGenerationInput & {
  naturalLanguage: string;
};

type ScriptGenerationSavePayload = {
  naturalLanguage: string;
  scriptNeedsGeneration?: boolean;
};

export function shouldGenerateScript(input: ScriptGenerationInput) {
  return input.scriptNeedsGeneration || !hasSavedScript(input.playwrightScript);
}

export function resolveScriptGenerationOnSave(
  existing: ScriptGenerationSaveInput,
  next: ScriptGenerationSavePayload,
) {
  const hasScript = hasSavedScript(existing.playwrightScript);

  if (next.naturalLanguage !== existing.naturalLanguage) {
    return {
      scriptNeedsGeneration: true,
      resetRunState: true,
      clearScript: hasScript,
    };
  }

  const requestedValue = next.scriptNeedsGeneration ?? existing.scriptNeedsGeneration;
  const scriptNeedsGeneration = hasScript ? requestedValue : true;

  return {
    scriptNeedsGeneration,
    resetRunState: scriptNeedsGeneration && !existing.scriptNeedsGeneration,
    clearScript: hasScript && scriptNeedsGeneration,
  };
}

function hasSavedScript(script: string | null) {
  return typeof script === "string" && script.trim().length > 0;
}
